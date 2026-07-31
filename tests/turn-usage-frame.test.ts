/**
 * usage frame が実際に sink へ出ることの検証 (抽出ロジック単体は
 * `turn-usage.test.ts`)。ここが壊れると Cc のコスト集計から codex-sdk
 * セッションが丸ごと落ちるが、抽出側の単体テストでは検出できない。
 *
 * `turn-stall.test.ts` と同じく、実 codex は使わず JSON-RPC を話す偽
 * app-server を `spawnProcess` で差し込む。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { SatellesCodexSession } from "../src/codex-session.js";
import { isStalledTurn } from "../src/runner.js";
import type {
  TranscriptFrameSink,
  TranscriptPostResult,
} from "../src/transcript-sink.js";

const THREAD_ID = "thread-usage-test";

const USAGE = {
  input_tokens: 42554,
  cached_input_tokens: 20224,
  cache_write_input_tokens: 0,
  output_tokens: 227,
  reasoning_output_tokens: 80,
  total_tokens: 42781,
};

interface RecordedFrame {
  kind: string;
  payload: Record<string, unknown>;
}

/** 送った frame をそのまま覚える sink。配送は常に成功。 */
class RecordingSink implements TranscriptFrameSink {
  readonly frames: RecordedFrame[] = [];
  private seq = 0;

  post(kind: string, payload: unknown): Promise<TranscriptPostResult> {
    this.frames.push({ kind, payload: payload as Record<string, unknown> });
    return Promise.resolve({ seq: this.seq++, persisted: true });
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  usageFrames(): Array<Record<string, unknown>> {
    return this.frames
      .filter((frame) => frame.kind === "raw" && frame.payload.type === "codex_usage")
      .map((frame) => frame.payload);
  }
}

interface FakeServerOptions {
  /** turn/completed に usage を載せるか。 */
  usage?: unknown;
  /**
   * 1 ターン目を沈黙させ (= 停滞で打ち切らせ)、2 ターン目の開始直後に
   * turn-1 の turn/completed を usage 付きで流す。
   */
  zombieUsageOnSecondStart?: boolean;
}

/** ハンドシェイクと turn/start だけ話す最小 app-server。 */
function fakeCodexAppServer(options: FakeServerOptions = {}): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  let exited = false;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 4243,
    kill: () => {
      if (exited) return true;
      exited = true;
      stdin.end();
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });

  let turnCount = 0;
  const send = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.id === undefined) continue; // notification
      switch (message.method) {
        case "initialize":
          send({ jsonrpc: "2.0", id: message.id, result: {} });
          break;
        case "account/read":
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              account: { type: "chatgpt", email: null, planType: "pro" },
              requiresOpenaiAuth: false,
            },
          });
          break;
        case "thread/start":
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { thread: { id: THREAD_ID, sessionId: "session-usage-test" } },
          });
          send({
            jsonrpc: "2.0",
            method: "thread/started",
            params: { thread: { id: THREAD_ID, sessionId: "session-usage-test" } },
          });
          break;
        case "turn/start": {
          turnCount += 1;
          const turnId = `turn-${turnCount}`;
          send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
          if (options.zombieUsageOnSecondStart) {
            // 1 ターン目は沈黙させて停滞させ、2 ターン目の最中に後追いさせる。
            if (turnCount === 2) {
              send({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: {
                  threadId: THREAD_ID,
                  turn: { id: "turn-1", status: "completed", usage: USAGE },
                },
              });
            }
            break;
          }
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: THREAD_ID,
              turn: { id: turnId, status: "completed", usage: options.usage },
            },
          });
          break;
        }
        default:
          send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    }
  });

  return child;
}

async function startFakeSession(
  sink: TranscriptFrameSink,
  options: FakeServerOptions = {},
): Promise<SatellesCodexSession> {
  return SatellesCodexSession.start({
    binary: "codex",
    cwd: process.cwd(),
    env: process.env,
    sink,
    clientVersion: "test",
    spawnProcess: () => fakeCodexAppServer(options),
  });
}

test("完了ターンの usage が codex_usage frame として出る", async () => {
  const sink = new RecordingSink();
  const session = await startFakeSession(sink, { usage: USAGE });
  try {
    const result = await session.runTurn({
      prompt: "hello",
      cwd: process.cwd(),
      stallTimeoutMs: 5_000,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(sink.usageFrames(), [{
      type: "codex_usage",
      thread_id: THREAD_ID,
      turn_id: "turn-1",
      input_tokens: 42554,
      cached_input_tokens: 20224,
      cache_write_input_tokens: 0,
      output_tokens: 227,
      reasoning_output_tokens: 80,
      total_tokens: 42781,
    }]);
  } finally {
    session.terminate();
  }
});

test("usage の無い完了ターンは codex_usage frame を出さない (turn は壊れない)", async () => {
  const sink = new RecordingSink();
  const session = await startFakeSession(sink);
  try {
    const result = await session.runTurn({
      prompt: "hello",
      cwd: process.cwd(),
      stallTimeoutMs: 5_000,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(sink.usageFrames(), []);
  } finally {
    session.terminate();
  }
});

test("想定外の usage 形でもターンは完了する (集計だけ諦める)", async () => {
  const sink = new RecordingSink();
  // usage: null は JSON で普通に起きる。ここで params の parse が落ちると
  // turn/completed の検出ごと死に、ターンが停滞扱いで失敗する。
  const session = await startFakeSession(sink, { usage: null });
  try {
    const result = await session.runTurn({
      prompt: "hello",
      cwd: process.cwd(),
      stallTimeoutMs: 5_000,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(sink.usageFrames(), []);
  } finally {
    session.terminate();
  }
});

test("打ち切った turn の後追い usage も集計面へ出る", async () => {
  const sink = new RecordingSink();
  const session = await startFakeSession(sink, { zombieUsageOnSecondStart: true });
  try {
    await assert.rejects(
      session.runTurn({ prompt: "one", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    // 停滞で打ち切っても、その turn が焼いたトークンは実在する。turn-1 の
    // 後追い turn/completed を捨てるとコストが恒久的に欠ける。
    await assert.rejects(
      session.runTurn({ prompt: "two", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    const frames = sink.usageFrames();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].turn_id, "turn-1");
    assert.equal(frames[0].total_tokens, 42781);
  } finally {
    session.terminate();
  }
});
