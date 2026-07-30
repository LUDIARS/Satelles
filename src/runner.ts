/**
 * Satelles の中核オーケストレーション:
 *
 *   register (Concordia) → app-server セッション起動 → ターンループ
 *     → agent テキストから ask マーカー検出 → pending-question POST
 *     → question.answered / session.inject を次ターン入力に
 *   → 終了時 unregister + close
 *
 * ウィンドウ無し・PTY 無し・rollout tail 無し。Discord へのリレーは
 * transcript-frame POST → Concordia egress に全部委ねる。
 */

import { parseAskMarkerText } from "./ask-marker.js";
import { buildCodexChildEnv } from "./child-env.js";
import { CodexTurnError, SatellesCodexSession } from "./codex-session.js";
import { buildConfigOverrides, type SatellesRunConfig } from "./config.js";
import {
  ConcordiaClient,
  loadConcordiaConfig,
  type LivenessHandle,
} from "./concordia-client.js";
import {
  assemblePreamble,
  composeFirstTurnPrompt,
  loadSkillTexts,
} from "./prompt-assemble.js";
import {
  OrderedTranscriptSink,
  VolatileTranscriptSink,
  type TranscriptFrameSink,
} from "./transcript-sink.js";
import { SATELLES_VERSION } from "./version.js";

interface IncomingInput {
  kind: "inject" | "answer";
  text: string;
  questionId: number | null;
}

/**
 * WS イベントを 1 本の入力キューに直列化する。ask 待ちでは answer/inject の
 * どちらでも回答として受ける (Discord カードのボタンでも生テキスト返信でも良い)。
 */
class InputQueue {
  private readonly queue: IncomingInput[] = [];
  private waiter: ((input: IncomingInput) => void) | null = null;

  push(input: IncomingInput): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(input);
      return;
    }
    this.queue.push(input);
  }

  take(): Promise<IncomingInput> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiter) return Promise.reject(new Error("input queue already has a waiter"));
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export interface RunnerDeps {
  log: (message: string) => void;
}

export async function runSatelles(config: SatellesRunConfig, deps?: RunnerDeps): Promise<void> {
  const log = deps?.log ?? ((m: string) => process.stderr.write(`satelles: ${m}\n`));
  const concordiaCfg = loadConcordiaConfig();
  const concordia = concordiaCfg.enabled ? new ConcordiaClient(concordiaCfg) : null;
  const inputs = new InputQueue();
  let liveness: LivenessHandle | null = null;
  let registered = false;

  let sink: TranscriptFrameSink;
  if (concordia) {
    try {
      await concordia.register({
        id: config.sessionId,
        provider: config.provider,
        repo_path: config.cwd,
        host: config.host,
        metadata: {
          wrapped_by: "satelles",
          satelles_version: SATELLES_VERSION,
          model: config.model,
          effort: config.effort,
          interactive: config.interactive,
          ...(config.delegationRunId ? { delegation_run_id: config.delegationRunId } : {}),
          ...(config.spawnEnrollment ? { concordia_spawn_id: config.spawnEnrollment } : {}),
        },
      });
      registered = true;
      liveness = concordia.openLiveness(config.sessionId, config.spawnEnrollment, (msg) => {
        handleWsEvent(msg, config.sessionId, inputs);
      });
      sink = new OrderedTranscriptSink({
        baseUrl: concordiaCfg.baseUrl,
        sessionId: config.sessionId,
      });
    } catch (error) {
      // Concordia 停止時は単体実行に degrade (CLAUDE.md 不変条件: coordinator
      // 停止でユーザに stack trace を見せない)。ただし interactive は入力経路が
      // Concordia しか無いので致命エラー。
      if (config.interactive) throw error;
      log(`Concordia unavailable, running standalone: ${(error as Error).message}`);
      sink = new VolatileTranscriptSink();
    }
  } else {
    sink = new VolatileTranscriptSink();
  }

  const session = await SatellesCodexSession.start({
    binary: config.codexBinary,
    cwd: config.cwd,
    env: buildCodexChildEnv(process.env),
    sink,
    clientVersion: SATELLES_VERSION,
    configOverrides: buildConfigOverrides(config),
    onDiagnostic: (message) => log(`codex app-server: ${message}`),
  });
  log(
    `Codex thread bound (${session.identity.threadId}) auth=${session.identity.authType}` +
    `${session.identity.planType ? `/${session.identity.planType}` : ""}`,
  );

  const stop = () => session.terminate();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // 停滞警告を Concordia の状態カードに出しているか (復帰時に消すため)。
  let stallNoticeVisible = false;
  // 委託 run の終了報告 (best-effort)。二重報告防止に一度だけ送る。
  let runStatusReported = false;
  const reportRunStatus = async (
    status: "completed" | "failed",
    detail?: string,
  ): Promise<void> => {
    if (!config.delegationRunId || !concordia || !registered || runStatusReported) return;
    runStatusReported = true;
    const ok = await concordia.postDelegationRunStatus(config.delegationRunId, {
      status,
      ...(detail ? { detail: detail.slice(0, 4_000) } : {}),
    });
    if (!ok) log(`delegation run status report failed (run=${config.delegationRunId})`);
  };

  try {
    const preamble = assemblePreamble({
      cwd: config.cwd,
      askMarker: registered,
      skills: loadSkillTexts(config.skillsDir),
      memory: config.memory,
    });

    let nextInput: string;
    if (config.taskPrompt !== null) {
      nextInput = composeFirstTurnPrompt(preamble, config.taskPrompt);
    } else {
      // interactive 開始入力待ち: 最初の inject にも前置テキストを付ける。
      log("waiting for first input (session.inject)...");
      const first = await inputs.take();
      nextInput = composeFirstTurnPrompt(preamble, first.text);
    }

    for (;;) {
      let result: Awaited<ReturnType<typeof session.runTurn>>;
      try {
        result = await session.runTurn({
          prompt: nextInput,
          cwd: config.cwd,
          networkAccess: config.networkAccess,
          turnTimeoutMs: config.turnTimeoutMs,
          stallTimeoutMs: config.stallTimeoutMs,
          onStall: ({ turnId, idleMs }) => {
            log(`codex turn stalled (turn=${turnId ?? "n/a"} idle=${Math.round(idleMs / 1_000)}s)`);
          },
        });
      } catch (error) {
        if (!isStalledTurn(error)) throw error;
        // 停滞したターンは、キュー済みの inject を何時間も人質に取る。ここで
        // ターンを手放し、セッションが「作業中」を演じ続けないよう degraded を
        // 表に出す。inject は InputQueue に順序どおり残っているので、対話
        // セッションは次の入力から再開できる。
        // 実際に ⚠️ を出せたときだけ「出している」と記録する。出せていない
        // のに復帰時の取り下げを走らせると、無関係な current_task を
        // "recovered from a stalled turn" で潰してしまう。
        stallNoticeVisible = await reportStall(
          concordia,
          registered,
          config.sessionId,
          (error as Error).message,
        );
        // 転記面にも 1 行残す: Discord 側は transcript しか見ていないので、
        // ここで黙ると「急に無言になった」だけの記録になる。
        await announceStall(sink, config.stallTimeoutMs, config.interactive, log);
        if (!config.interactive) throw error;
        log("recovering from stalled turn; waiting for the next input");
        const next = await inputs.take();
        nextInput = next.text;
        continue;
      }

      if (stallNoticeVisible) {
        // 復帰したのに ⚠️ を出したままにすると、今度は逆に動いている
        // セッションを止まっていると誤読させる。
        stallNoticeVisible = false;
        await clearStallNotice(concordia, registered, config.sessionId);
      }

      const ask = parseAskMarkerText(result.agentText);
      if (ask) {
        let questionId: number | null = null;
        if (concordia && registered) {
          questionId = await concordia.postPendingQuestion(config.sessionId, {
            question: ask.question,
            options: ask.options,
            multiSelect: ask.multiSelect,
          });
        }
        if (!concordia || !registered) {
          // 回答経路が無い one-shot: 質問で止まっても誰も答えられないので終了する。
          log("ask marker emitted but no Concordia relay available; ending turn loop");
          break;
        }
        log(`ask marker relayed (question_id=${questionId ?? "n/a"}); waiting for answer`);
        const answer = await waitForAnswer(inputs, questionId);
        nextInput = answer;
        continue;
      }

      if (!config.interactive) break;
      const next = await inputs.take();
      nextInput = next.text;
    }

    await session.close();
    await reportRunStatus("completed");
  } catch (error) {
    await reportRunStatus("failed", (error as Error).message);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    session.terminate();
    liveness?.close();
    if (concordia && registered) await concordia.unregister(config.sessionId);
  }
}

/** 無進捗で打ち切られたターンか。 */
export function isStalledTurn(error: unknown): boolean {
  return error instanceof CodexTurnError && error.code === "codex_turn_stalled";
}

/**
 * 停滞を Concordia へ表に出す (best-effort)。
 *
 * これが無いと、セッションは last_seen_at が止まったまま `active` に見え続け、
 * 人間からは「作業中」と区別できない。イベントは Cc 側の可視面
 * (状態カード / エラー通知) が拾う。
 *
 * 戻り値は `current_task` に警告を出せたか (= 復帰時に取り下げるべきか)。
 */
async function reportStall(
  concordia: ConcordiaClient | null,
  registered: boolean,
  sessionId: string,
  detail: string,
): Promise<boolean> {
  if (!concordia || !registered) return false;
  try {
    await concordia.event(sessionId, {
      kind: "codex_turn_stalled",
      payload: { detail },
    });
    await concordia.patchSession(sessionId, {
      current_task: `⚠️ codex turn stalled — ${detail}`,
    });
    return true;
  } catch {
    // 監視面への報告失敗でセッションを落とさない。
    return false;
  }
}

/** ミリ秒を人間向けの長さ表現へ。 */
function formatStallTimeout(timeoutMs: number | null): string {
  if (timeoutMs === null) return "";
  const minutes = timeoutMs / 60_000;
  return Number.isInteger(minutes) ? `${minutes} 分` : `${Math.round(timeoutMs / 1_000)} 秒`;
}

/**
 * 停滞を転記面へ 1 行出す (best-effort)。
 *
 * Discord から見えるのは transcript だけなので、ここに出さないと停滞は
 * 「返事が来なくなった」以上の情報を持たない。対話は次の入力で再開できる旨、
 * one-shot / 委託は失敗として終わる旨まで書いて、人間の次の一手を決められる
 * ようにする。
 */
async function announceStall(
  sink: TranscriptFrameSink,
  stallTimeoutMs: number | null,
  interactive: boolean,
  log: (message: string) => void,
): Promise<void> {
  const idleText = stallTimeoutMs === null
    ? "Codex の進捗が途絶えたため"
    : `Codex の進捗が ${formatStallTimeout(stallTimeoutMs)}途絶えたため`;
  const text = interactive
    ? `Satelles: ${idleText}、このターンを打ち切りました。次の入力から再開できます。`
    : `Satelles: ${idleText}、このセッションを失敗として終了します。`
      + "長時間処理は TaskWorkflow で実行してください。";
  log(text);
  try {
    await sink.post("text", {
      role: "assistant",
      text,
      phase: "final",
      error_code: "codex_turn_stalled",
      timeout_ms: stallTimeoutMs,
    });
    await sink.flush();
  } catch (error) {
    log(`stall relay failed: ${(error as Error).message}`);
  }
}

/** 停滞警告の取り下げ (best-effort。reportStall と対になる)。 */
async function clearStallNotice(
  concordia: ConcordiaClient | null,
  registered: boolean,
  sessionId: string,
): Promise<void> {
  if (!concordia || !registered) return;
  try {
    await concordia.patchSession(sessionId, {
      current_task: "recovered from a stalled turn",
    });
  } catch {
    // 同上。
  }
}

/**
 * ask への回答を待つ。question.answered は question_id 一致のみ採用、
 * 生テキスト inject は無条件で回答として扱う (Lictor の三分岐と同じ寛容さ)。
 * 不一致の answer は捨てて待ち続ける。
 */
async function waitForAnswer(inputs: InputQueue, questionId: number | null): Promise<string> {
  for (;;) {
    const input = await inputs.take();
    if (input.kind === "inject") return input.text;
    if (questionId === null || input.questionId === questionId) return input.text;
  }
}

/** Concordia WS broadcast を入力キューへ写像する。 */
export function handleWsEvent(msg: unknown, ownSessionId: string, inputs: InputQueue): void {
  if (typeof msg !== "object" || msg === null) return;
  const ev = msg as Record<string, unknown>;
  if (ev.type === "session.inject") {
    if (ev.target_session_id !== ownSessionId) return;
    if (typeof ev.text !== "string" || ev.text.length === 0) return;
    inputs.push({ kind: "inject", text: ev.text, questionId: null });
    return;
  }
  if (ev.type === "question.answered") {
    if (ev.target_session_id !== ownSessionId) return;
    if (typeof ev.question_id !== "number" || !Number.isInteger(ev.question_id)) return;
    const text = typeof ev.answer_text === "string" ? ev.answer_text : "";
    if (!text) return;
    inputs.push({ kind: "answer", text, questionId: ev.question_id });
  }
}

export type { IncomingInput };
export { InputQueue };
