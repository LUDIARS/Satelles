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
import { SatellesCodexSession } from "./codex-session.js";
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
    env: process.env,
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
      const result = await session.runTurn({
        prompt: nextInput,
        cwd: config.cwd,
        networkAccess: config.networkAccess,
        turnTimeoutMs: config.turnTimeoutMs,
      });

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
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    session.terminate();
    liveness?.close();
    if (concordia && registered) await concordia.unregister(config.sessionId);
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
