import { z } from "zod";
import {
  CodexAppServerClient,
  type CodexRpcNotification,
  type CodexServerRequestHandler,
  type SpawnCodexAppServerOptions,
} from "./codex-app-server-client.js";
import {
  CodexEventFrameMapper,
  notificationThreadId,
  notificationTurnId,
  parseTurnCompletion,
  parseTurnUsage,
} from "./codex-event-frames.js";
import {
  bootstrapCodexSession,
  type CodexSessionIdentity,
} from "./codex-bootstrap.js";
import { turnStartModelEffort } from "./runtime-model-effort.js";
import type { TranscriptFrameSink } from "./transcript-sink.js";
import { TurnStallTimer, type TurnStallTimerScheduler } from "./turn-stall-timer.js";
import { codexRuntimeCwd } from "./wsl-path.js";

const TurnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1),
    status: z.string(),
  }).passthrough(),
}).passthrough();

const ItemCompletedSchema = z.object({
  threadId: z.string().optional(),
  item: z.object({
    id: z.string(),
    type: z.string(),
    text: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

export type CodexTurnErrorCode =
  | "codex_turn_start_failed"
  | "codex_turn_failed"
  | "codex_thread_mismatch"
  | "codex_turn_timeout"
  /** イベントが途絶えたまま無進捗になった (絶対上限より手前で検知する)。 */
  | "codex_turn_stalled";

export class CodexTurnError extends Error {
  constructor(
    public readonly code: CodexTurnErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexTurnError";
  }
}

export interface StartSatellesCodexSessionOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sink: TranscriptFrameSink;
  clientVersion: string;
  /** `codex -c key=value` overrides (model=..., model_reasoning_effort=...). */
  configOverrides?: string[];
  /** `"native"` (既定) か `"wsl"` (WSL 内 Linux codex への spawn 差替え)。 */
  runtime?: "native" | "wsl";
  /**
   * `"workspace-write"` (既定) か `"danger-full-access"` (sandbox 起動を外す)。
   * runtime=native で Windows 版 codex の sandbox launcher が持つ lsass
   * ログオンセッションリーク (upstream #33356 / #35940) を踏まないための迂回。
   */
  sandbox?: "workspace-write" | "danger-full-access";
  wslDistro?: string;
  wslUser?: string;
  wslCodexBinary?: string;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  serverRequestHandler?: CodexServerRequestHandler;
  spawnProcess?: SpawnCodexAppServerOptions["spawnProcess"];
}

export interface RunTurnOptions {
  prompt: string;
  cwd: string;
  /** 絶対上限。null で無効 (委託 run は TaskWorkflow が期限を持つ)。 */
  turnTimeoutMs?: number | null;
  /**
   * ターンのイベントが 1 本も来なくなってから停滞と判定するまでの間隔。
   * null で無効。絶対上限 (turnTimeoutMs) は最後の安全弁として別に効く。
   */
  stallTimeoutMs?: number | null;
  /** テスト用の時計差し替え。 */
  stallScheduler?: TurnStallTimerScheduler;
  /** 停滞を検知したときの通知 (best-effort。投げても turn の結果は変えない)。 */
  onStall?: (info: { turnId: string | null; idleMs: number }) => void;
  /** 既定 false (delegation 同等)。対話用途では true を推奨。 */
  networkAccess?: boolean;
  /**
   * このターン以降に使う model / reasoning effort (sidecar の runtime 切替)。
   * null / 未指定なら送らず、thread の現在値 (起動時の -c override) を使う。
   */
  model?: string | null;
  effort?: string | null;
}

export interface TurnResult {
  /** turn/completed の status ("completed" 以外はエラーとして投げるので常に completed)。 */
  status: string;
  /** このターンで完了した agentMessage テキストの連結 (ask マーカー検出用)。 */
  agentText: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

function turnSandboxPolicy(
  sandbox: "workspace-write" | "danger-full-access",
  cwd: string,
  networkAccess: boolean,
) {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" } as const;
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess,
  } as const;
}

/**
 * `stallTimeoutMs` 未指定時の保険値 (ライブラリとしての既定)。
 *
 * 4 時間の絶対上限だけでは、イベントが途絶えたターン (2026-07-30 incident:
 * turn/started の後 15 分で無音になり turn/completed が来ない) を何時間も
 * 「作業中」に見せたまま、後続の inject を消費できない状態が続く。
 *
 * CLI から来る実運用の期限はここではなく `config.ts` のポリシーが決める
 * (serve は既定かつ上限 5 分、one-shot は既定無し、委託 run は null)。
 * runner は必ず明示値か null を渡すので、この値が効くのは
 * `runTurn` を直接呼ぶ経路だけ。
 */
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * 覚えておく「打ち切った turn」の上限。
 *
 * 通常は当該 turn の `turn/completed` を観測した時点で忘れるが、その
 * イベントはターン間 (notification listener を外している窓) に届くことが
 * あり、その場合 id は残り続ける。長寿命の interactive セッションで
 * 際限なく溜めないための保険。
 */
const MAX_ABANDONED_TURN_IDS = 32;

/**
 * 1 本の `codex app-server` プロセスに 1 thread を束ね、複数ターンを
 * 順に実行する常駐セッション。プロセスを生かしたまま turn を重ねるので
 * rollout resume が不要 (= codex 0.144.x のターン0 resume バグを構造的に回避)。
 *
 * すべての notification は {@link CodexEventFrameMapper} で Concordia
 * transcript フレームへ写像して sink へ流す。rollout JSONL の tail は一切
 * 行わない (ファイル監視ゼロ)。
 */
export class SatellesCodexSession {
  private turning = false;
  /**
   * 停滞として打ち切った turn の id。app-server 側ではその turn がまだ生きて
   * いる可能性があり、後から item/completed や turn/completed が飛んでくる。
   * 次ターンがそれを自分のイベントと取り違えると (turn id 未確定の窓では
   * 即座に「完了」、確定後は codex_thread_mismatch でセッションごと落ちる)
   * 停滞回復そのものが壊れるので、ここで持ち主を覚えて無視する。
   */
  private readonly abandonedTurnIds = new Set<string>();

  private constructor(
    public readonly client: CodexAppServerClient,
    public readonly sink: TranscriptFrameSink,
    public readonly identity: CodexSessionIdentity,
    private readonly mapper: CodexEventFrameMapper,
    private readonly runtime: "native" | "wsl" | undefined,
    private readonly sandbox: "workspace-write" | "danger-full-access",
  ) {}

  static async start(options: StartSatellesCodexSessionOptions): Promise<SatellesCodexSession> {
    const client = CodexAppServerClient.spawn({
      binary: options.binary,
      cwd: options.cwd,
      env: options.env,
      configOverrides: options.configOverrides,
      runtime: options.runtime,
      wslDistro: options.wslDistro,
      wslUser: options.wslUser,
      wslCodexBinary: options.wslCodexBinary,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: options.onDiagnostic,
      serverRequestHandler: options.serverRequestHandler,
      spawnProcess: options.spawnProcess,
    });
    try {
      // WSL 内 codex には JSON-RPC `thread/start` の cwd も WSL パスで渡す。
      const bootstrapCwd = codexRuntimeCwd(options.runtime, options.cwd);
      const sandbox = options.sandbox ?? "workspace-write";
      const identity = await bootstrapCodexSession(client, options.sink, {
        cwd: bootstrapCwd,
        clientVersion: options.clientVersion,
        approvalPolicy: "never",
        sandbox,
      });
      return new SatellesCodexSession(
        client,
        options.sink,
        identity,
        new CodexEventFrameMapper(identity.threadId),
        options.runtime,
        sandbox,
      );
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 1 ターンを実行し、完了までの agentMessage テキストを収集して返す。
   * 同時に 1 ターンのみ (並行 runTurn は呼び出し側バグとして投げる)。
   */
  async runTurn(options: RunTurnOptions): Promise<TurnResult> {
    if (this.turning) {
      throw new CodexTurnError("codex_turn_start_failed", "a turn is already running");
    }
    this.turning = true;
    try {
      return await this.runTurnInner(options);
    } finally {
      this.turning = false;
    }
  }

  async close(): Promise<void> {
    let flushError: Error | null = null;
    try {
      await this.sink.flush();
    } catch (error) {
      flushError = asError(error);
    }
    await this.client.close();
    if (flushError) throw flushError;
  }

  terminate(): void {
    this.client.terminate();
  }

  /** 打ち切った turn を記録する (古いものから捨てて上限を超えない)。 */
  private rememberAbandonedTurn(turnId: string): void {
    this.abandonedTurnIds.add(turnId);
    while (this.abandonedTurnIds.size > MAX_ABANDONED_TURN_IDS) {
      const oldest: string | undefined = this.abandonedTurnIds.values().next().value;
      if (oldest === undefined) break;
      this.abandonedTurnIds.delete(oldest);
    }
  }

  /**
   * turn/completed の usage を集計用 raw frame として積む。usage が読めない
   * turn は黙って何もしない。
   *
   * 送信の reject はここで握り潰すが、恒久失敗した sink はそれ自体が
   * poison される設計なので、後続の flush が turn を失敗させることはある。
   * 「usage の送信だけが静かに欠ける」保証ではない。
   */
  private postTurnUsage(notification: CodexRpcNotification): void {
    const usage = parseTurnUsage(notification, this.identity.threadId);
    if (!usage) return;
    void this.sink.post("raw", {
      type: "codex_usage",
      thread_id: usage.threadId,
      turn_id: usage.turnId,
      input_tokens: usage.inputTokens ?? null,
      cached_input_tokens: usage.cachedInputTokens ?? null,
      cache_write_input_tokens: usage.cacheWriteInputTokens ?? null,
      output_tokens: usage.outputTokens ?? null,
      reasoning_output_tokens: usage.reasoningOutputTokens ?? null,
      total_tokens: usage.totalTokens ?? null,
    }).catch(() => undefined);
  }

  private async runTurnInner(options: RunTurnOptions): Promise<TurnResult> {
    let activeTurnId: string | null = null;
    let settled = false;
    let terminalReceived = false;
    const agentTexts: string[] = [];
    let resolveCompletion: ((status: string) => void) | null = null;
    let rejectCompletion: ((error: Error) => void) | null = null;
    const completionPromise = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // `turn/start` は bootstrap とは別の JSON-RPC 呼び出しで cwd と
    // writableRoots を評価する。WSL runtime では両方を Linux 側の形式にする。
    const codexCwd = codexRuntimeCwd(this.runtime, options.cwd);
    // completionPromise は turn/start が返ってから初めて await される。その手前で
    // notification ハンドラや停滞タイマが reject すると、ハンドラ未装着のまま
    // unhandledRejection になり Satelles プロセスごと落ちる (turn/start 自体が
    // 失敗する経路では最後まで await されない)。空の catch を先に付けて
    // 「処理済み」にしておく — 後段の await は通常どおり reject を受け取る。
    void completionPromise.catch(() => undefined);

    // 無進捗ウォッチドッグ: 権威ある notification のたびに延長し、途絶えたら
    // 停滞として turn を終わらせる。これが無いと絶対上限まで runner が
    // runTurn を await したまま、キュー済みの inject を消費できない。
    // null は「無効」(委託 run は TaskWorkflow が期限を持つ)。
    const stallTimeoutMs = options.stallTimeoutMs === null
      ? null
      : positiveInt(options.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS);
    let lastProgressAt = Date.now();
    const stallTimer = new TurnStallTimer(stallTimeoutMs, () => {
      if (settled) return;
      settled = true;
      // 打ち切った turn は app-server 側でまだ生きている可能性がある。
      if (activeTurnId) this.rememberAbandonedTurn(activeTurnId);
      const idleMs = Date.now() - lastProgressAt;
      try {
        options.onStall?.({ turnId: activeTurnId, idleMs });
      } catch {
        // 通知は落としてよい。停滞の報告自体で turn を壊さない。
      }
      rejectCompletion?.(new CodexTurnError(
        "codex_turn_stalled",
        `Codex turn produced no events for ${Math.round(idleMs / 1_000)}s`,
      ));
    }, options.stallScheduler);

    const unsubscribe = this.client.onNotification((notification) => {
      if (settled) return;
      const observedTurnId = this.abandonedTurnIds.size > 0
        ? notificationTurnId(notification)
        : null;
      if (observedTurnId && this.abandonedTurnIds.has(observedTurnId)) {
        // 打ち切った turn のゾンビイベント。転記面には出す (Discord 側の
        // 記録は正直なままにする) が、現ターンの進捗・完了・agentText には
        // 一切数えない。ウォッチドッグの延長にも使わない。
        const zombie = this.mapper.map(notification);
        if (zombie) void this.sink.post(zombie.kind, zombie.payload).catch(() => undefined);
        // 打ち切った turn もトークンは実際に焼いている。frame 自体が turn_id を
        // 持つので、現ターンに数えずに集計面へだけ出す。
        this.postTurnUsage(notification);
        // その turn が完了したなら、もう後追いイベントは来ない。長寿命の
        // interactive セッションで停滞が繰り返されても id が溜まり続けない
        // よう、ここで持ち主を忘れる。
        if (notification.method === "turn/completed") {
          this.abandonedTurnIds.delete(observedTurnId);
        }
        return;
      }
      const observedThreadId = notificationThreadId(notification);
      if (observedThreadId && observedThreadId !== this.identity.threadId) {
        settled = true;
        rejectCompletion?.(new CodexTurnError(
          "codex_thread_mismatch",
          `received ${notification.method} for an unexpected Codex thread`,
        ));
        return;
      }
      // 進捗として数えるのは束ねた thread のイベントだけ。他 thread の音で
      // ウォッチドッグを延ばすと、止まった turn を生きていると誤認する。
      if (observedThreadId === this.identity.threadId) {
        lastProgressAt = Date.now();
        stallTimer.progress();
      }

      collectAgentText(notification.method, notification.params, this.identity.threadId, agentTexts);

      const frame = this.mapper.map(notification);
      const framePost = frame
        ? this.sink.post(frame.kind, frame.payload)
        : Promise.resolve(null);
      const completion = parseTurnCompletion(notification, this.identity.threadId);
      if (!completion) {
        void framePost.catch((error: unknown) => {
          if (settled) return;
          settled = true;
          rejectCompletion?.(asError(error));
        });
        return;
      }
      if (activeTurnId && completion.turnId !== activeTurnId) {
        settled = true;
        rejectCompletion?.(new CodexTurnError(
          "codex_thread_mismatch",
          "turn/completed did not match the active turn",
        ));
        return;
      }
      // Codex 側は終端イベントに到達した。ここから先の待ちは transcript の
      // 永続化 (独自のリトライ上限を持つ) であって turn の停滞ではないので、
      // ウォッチドッグを止める。
      terminalReceived = true;
      stallTimer.stop();
      // usage は Cc のコスト集計の一次ソース。rollout tail を持たない
      // codex-sdk セッションは、この frame を出さないと集計対象にならない。
      // turn/completed frame より後に積むので、下の flush が配送まで見る。
      this.postTurnUsage(notification);
      void framePost
        .then(() => this.sink.flush())
        .then(() => {
          if (settled) return;
          settled = true;
          if (completion.status === "completed") {
            resolveCompletion?.(completion.status);
            return;
          }
          rejectCompletion?.(new CodexTurnError(
            "codex_turn_failed",
            `Codex turn ended with status=${completion.status}${
              completion.errorMessage ? `: ${completion.errorMessage}` : ""
            }`,
          ));
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          rejectCompletion?.(asError(error));
        });
    });

    try {
      let turnRaw: unknown;
      try {
        turnRaw = await this.client.request("turn/start", {
          threadId: this.identity.threadId,
          input: [{ type: "text", text: options.prompt }],
          cwd: codexCwd,
          approvalPolicy: "never",
          sandboxPolicy: turnSandboxPolicy(
            this.sandbox,
            codexCwd,
            options.networkAccess === true,
          ),
          ...turnStartModelEffort(options),
        });
      } catch (error) {
        throw new CodexTurnError(
          "codex_turn_start_failed",
          "Codex turn/start failed",
          { cause: asError(error) },
        );
      }
      const turnResult = TurnStartResponseSchema.safeParse(turnRaw);
      if (!turnResult.success) {
        throw new CodexTurnError(
          "codex_turn_start_failed",
          "Codex turn/start response omitted the turn id",
        );
      }
      activeTurnId = turnResult.data.turn.id;
      // 万一 app-server が turn id を再利用しても、現ターンを打ち切り済み
      // 扱いにして無視し続けることが無いようにする。
      this.abandonedTurnIds.delete(activeTurnId);
      // turn/start が返った時点から計測する: 最初のイベントが 1 本も来ない
      // ケース (incident の形) もここで拾える。ただし turn/completed が
      // turn/start の応答より先に届いていたら、もう待つものは無い。
      lastProgressAt = Date.now();
      if (!terminalReceived) stallTimer.start();

      // 絶対上限は最後の安全弁。null は「無効」(委託 run は TaskWorkflow が期限を持つ)。
      const status = options.turnTimeoutMs === null
        ? await completionPromise
        : await withTimeout(
          completionPromise,
          positiveInt(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
          () => new CodexTurnError("codex_turn_timeout", "Codex turn timed out"),
        );
      return { status, agentText: agentTexts.join("\n") };
    } finally {
      settled = true;
      stallTimer.stop();
      unsubscribe();
    }
  }
}

function collectAgentText(
  method: string,
  params: unknown,
  expectedThreadId: string,
  out: string[],
): void {
  if (method !== "item/completed") return;
  const parsed = ItemCompletedSchema.safeParse(params);
  if (!parsed.success) return;
  if (parsed.data.threadId !== expectedThreadId) return;
  const item = parsed.data.item;
  if (!item || item.type !== "agentMessage") return;
  if (typeof item.text === "string" && item.text.trim()) out.push(item.text);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function positiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
