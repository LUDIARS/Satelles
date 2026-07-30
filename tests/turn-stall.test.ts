/**
 * 無進捗ウォッチドッグの検証。
 *
 * 実 codex は使わず、JSON-RPC を話す偽 app-server プロセスを `spawnProcess` で
 * 差し込む。ハンドシェイクだけ応答し、turn/start の後は意図的に沈黙させて
 * 2026-07-30 incident (turn/started の後イベントが途絶える) を再現する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexTurnError, SatellesCodexSession } from "../src/codex-session.js";
import { InputQueue, isStalledTurn } from "../src/runner.js";
import { VolatileTranscriptSink } from "../src/transcript-sink.js";

const THREAD_ID = "thread-stall-test";

interface FakeServerOptions {
  /** turn/start に応答したあとイベントを流すか (既定 false = 沈黙 = 停滞)。 */
  completeTurn?: boolean;
  /**
   * 2 ターン目の turn/start 応答の直後に、1 ターン目 (停滞で打ち切った turn) の
   * 後追いイベントを流す。app-server 側で古い turn が生きていた場合の再現。
   */
  zombieFirstTurnOnSecondStart?: boolean;
}

/** ハンドシェイクだけ話す最小 app-server。turn は既定で沈黙する。 */
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
    pid: 4242,
    // 実プロセスと同じく kill で 'exit' を出す。出さないと client.close() が
    // exitPromise を待ち続け、テストが終わらない。
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
            result: { thread: { id: THREAD_ID, sessionId: "session-stall-test" } },
          });
          send({
            jsonrpc: "2.0",
            method: "thread/started",
            params: { thread: { id: THREAD_ID, sessionId: "session-stall-test" } },
          });
          break;
        case "turn/start": {
          turnCount += 1;
          const turnId = `turn-${turnCount}`;
          send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
          if (options.completeTurn) {
            send({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: { threadId: THREAD_ID, turn: { id: turnId, status: "completed" } },
            });
          }
          if (options.zombieFirstTurnOnSecondStart && turnCount === 2) {
            send({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: THREAD_ID,
                turnId: "turn-1",
                item: { id: "item-zombie", type: "agentMessage", text: "late output from turn-1" },
              },
            });
            send({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: { threadId: THREAD_ID, turn: { id: "turn-1", status: "completed" } },
            });
          }
          // 既定は何も送らない = 無進捗。
          break;
        }
        default:
          send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    }
  });

  return child;
}

async function startFakeSession(options: FakeServerOptions = {}): Promise<SatellesCodexSession> {
  return SatellesCodexSession.start({
    binary: "codex",
    cwd: process.cwd(),
    env: process.env,
    sink: new VolatileTranscriptSink(),
    clientVersion: "test",
    spawnProcess: () => fakeCodexAppServer(options),
  });
}

test("イベントが来ないターンを停滞として打ち切る", async () => {
  const session = await startFakeSession();
  const stalls: Array<{ turnId: string | null; idleMs: number }> = [];
  try {
    await assert.rejects(
      session.runTurn({
        prompt: "hello",
        cwd: process.cwd(),
        stallTimeoutMs: 120,
        onStall: (info) => stalls.push(info),
      }),
      (error: unknown) =>
        error instanceof CodexTurnError
        && error.code === "codex_turn_stalled"
        && isStalledTurn(error),
    );
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].turnId, "turn-1");
    assert.ok(stalls[0].idleMs >= 100, `idleMs=${stalls[0].idleMs}`);
  } finally {
    session.terminate();
  }
});

test("停滞検知は絶対上限より手前で起きる (上限は最後の安全弁のまま)", async () => {
  const session = await startFakeSession();
  const startedAt = Date.now();
  try {
    await assert.rejects(
      session.runTurn({
        prompt: "hello",
        cwd: process.cwd(),
        stallTimeoutMs: 120,
        // 絶対上限は桁違いに長い: 先に鳴るのは停滞側。
        turnTimeoutMs: 60_000,
      }),
      (error: unknown) => error instanceof CodexTurnError && error.code === "codex_turn_stalled",
    );
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    session.terminate();
  }
});

test("停滞しないターンはウォッチドッグに殺されない", async () => {
  const session = await startFakeSession({ completeTurn: true });
  try {
    const result = await session.runTurn({
      prompt: "hello",
      cwd: process.cwd(),
      stallTimeoutMs: 5_000,
    });
    assert.equal(result.status, "completed");
  } finally {
    session.terminate();
  }
});

test("停滞中に届いた inject は順序どおり残り、復帰後に消費できる", async () => {
  const session = await startFakeSession();
  const inputs = new InputQueue();
  try {
    await assert.rejects(
      session.runTurn({ prompt: "hello", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    // 停滞中に積まれた入力が失われず、順序も保たれること。
    inputs.push({ kind: "inject", text: "first", questionId: null });
    inputs.push({ kind: "inject", text: "second", questionId: null });
    assert.equal((await inputs.take()).text, "first");
    assert.equal((await inputs.take()).text, "second");
  } finally {
    session.terminate();
  }
});

test("停滞後も同じ thread で次のターンを開始できる", async () => {
  const session = await startFakeSession();
  try {
    await assert.rejects(
      session.runTurn({ prompt: "one", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    // 停滞は turning フラグを解放する: 解放し損ねると次ターンが
    // "a turn is already running" で永久に始まらない。
    await assert.rejects(
      session.runTurn({ prompt: "two", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    assert.equal(session.identity.threadId, THREAD_ID);
  } finally {
    session.terminate();
  }
});

test("打ち切った turn の後追いイベントは次ターンに混ざらない", async () => {
  const session = await startFakeSession({ zombieFirstTurnOnSecondStart: true });
  try {
    await assert.rejects(
      session.runTurn({ prompt: "one", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
    // 2 ターン目の最中に turn-1 の item/completed + turn/completed が届く。
    // これを現ターンのものと取り違えると、(a) 何もしていない turn-2 が即
    // "completed" で返る、(b) turn id 不一致で codex_thread_mismatch に落ちて
    // セッションごと死ぬ、のどちらかになる。正しくは無視して停滞のまま。
    await assert.rejects(
      session.runTurn({ prompt: "two", cwd: process.cwd(), stallTimeoutMs: 120 }),
      (error: unknown) => isStalledTurn(error),
    );
  } finally {
    session.terminate();
  }
});
