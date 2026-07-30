import { z } from "zod";
import {
  CodexAppServerClient,
  type CodexServerRequestHandler,
  type SpawnCodexAppServerOptions,
} from "./codex-app-server-client.js";
import {
  CodexEventFrameMapper,
  notificationThreadId,
  parseTurnCompletion,
} from "./codex-event-frames.js";
import {
  bootstrapCodexSession,
  type CodexSessionIdentity,
} from "./codex-bootstrap.js";
import type { TranscriptFrameSink } from "./transcript-sink.js";

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
  | "codex_turn_timeout";

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
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  serverRequestHandler?: CodexServerRequestHandler;
  spawnProcess?: SpawnCodexAppServerOptions["spawnProcess"];
}

export interface RunTurnOptions {
  prompt: string;
  cwd: string;
  turnTimeoutMs?: number;
  /** 既定 false (delegation 同等)。対話用途では true を推奨。 */
  networkAccess?: boolean;
}

export interface TurnResult {
  /** turn/completed の status ("completed" 以外はエラーとして投げるので常に completed)。 */
  status: string;
  /** このターンで完了した agentMessage テキストの連結 (ask マーカー検出用)。 */
  agentText: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

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

  private constructor(
    public readonly client: CodexAppServerClient,
    public readonly sink: TranscriptFrameSink,
    public readonly identity: CodexSessionIdentity,
    private readonly mapper: CodexEventFrameMapper,
  ) {}

  static async start(options: StartSatellesCodexSessionOptions): Promise<SatellesCodexSession> {
    const client = CodexAppServerClient.spawn({
      binary: options.binary,
      cwd: options.cwd,
      env: options.env,
      configOverrides: options.configOverrides,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: options.onDiagnostic,
      serverRequestHandler: options.serverRequestHandler,
      spawnProcess: options.spawnProcess,
    });
    try {
      const identity = await bootstrapCodexSession(client, options.sink, {
        cwd: options.cwd,
        clientVersion: options.clientVersion,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      return new SatellesCodexSession(
        client,
        options.sink,
        identity,
        new CodexEventFrameMapper(identity.threadId),
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

  private async runTurnInner(options: RunTurnOptions): Promise<TurnResult> {
    let activeTurnId: string | null = null;
    let settled = false;
    const agentTexts: string[] = [];
    let resolveCompletion: ((status: string) => void) | null = null;
    let rejectCompletion: ((error: Error) => void) | null = null;
    const completionPromise = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const unsubscribe = this.client.onNotification((notification) => {
      if (settled) return;
      const observedThreadId = notificationThreadId(notification);
      if (observedThreadId && observedThreadId !== this.identity.threadId) {
        settled = true;
        rejectCompletion?.(new CodexTurnError(
          "codex_thread_mismatch",
          `received ${notification.method} for an unexpected Codex thread`,
        ));
        return;
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
          cwd: options.cwd,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [options.cwd],
            networkAccess: options.networkAccess === true,
          },
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

      const status = await withTimeout(
        completionPromise,
        positiveInt(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
        () => new CodexTurnError("codex_turn_timeout", "Codex turn timed out"),
      );
      return { status, agentText: agentTexts.join("\n") };
    } finally {
      settled = true;
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

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
