/**
 * Runtime model / effort switch: sidecar contract (Lictor-compatible) and
 * application to the next `turn/start`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { SatellesCodexSession } from "../src/codex-session.js";
import { RuntimeModelEffortState } from "../src/runtime-model-effort.js";
import { startSessionSidecar } from "../src/session-sidecar.js";
import { SessionSidecarRoutes } from "../src/session-sidecar-routes.js";
import { publishSidecarPort, SATELLES_SIDECAR_PORT_KEY } from "../src/sidecar-port-publish.js";
import { VolatileTranscriptSink } from "../src/transcript-sink.js";

function routesWith(state = new RuntimeModelEffortState()) {
  const routes = new SessionSidecarRoutes({
    sessionId: "satelles-child",
    concordia: {
      chat: async () => ({}),
      report: async () => ({}),
      patchSession: async () => undefined,
    },
    requestShutdown: () => undefined,
    runtimeModelEffort: state,
  });
  return { routes, state };
}

test("state validates codex effort / model and keeps the latest switch for the next turn", () => {
  const state = new RuntimeModelEffortState();
  assert.deepEqual(state.forNextTurn(), { model: null, effort: null });
  assert.deepEqual(state.apply({ model: "gpt-5.5", effort: "max" }), { ok: false, status: 400, error: "invalid_effort" });
  assert.deepEqual(state.apply({ model: "bad model\r/x", effort: "high" }), { ok: false, status: 400, error: "invalid_model" });
  assert.deepEqual(state.forNextTurn(), { model: null, effort: null });
  const ok = state.apply({ model: " gpt-5.5 ", effort: " HIGH " });
  assert.equal(ok.ok, true);
  assert.deepEqual(state.forNextTurn(), { model: "gpt-5.5", effort: "high" });
});

test("sidecar route keeps the Lictor body / reply shape", async () => {
  const { routes, state } = routesWith();
  const ok = await routes.handle("POST", "/v1/runtime/model-effort", { model: "gpt-5.5", effort: "low" });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { ok: boolean }).ok, true);
  assert.equal(typeof (ok.body as { message: unknown }).message, "string");
  assert.deepEqual(state.forNextTurn(), { model: "gpt-5.5", effort: "low" });

  const missing = await routes.handle("POST", "/v1/runtime/model-effort", { effort: "low" });
  assert.deepEqual(missing, { status: 400, body: { error: "body.model and body.effort (string) are required" } });
  const bad = await routes.handle("POST", "/v1/runtime/model-effort", { model: "gpt-5.5", effort: "turbo" });
  assert.deepEqual(bad, { status: 400, body: { error: "invalid_effort" } });
  assert.equal((await routes.handle("GET", "/v1/runtime/model-effort", {})).status, 404);
});

test("HTTP listener serves the switch only to loopback CLI callers", async () => {
  const { state } = routesWith();
  const sidecar = await startSessionSidecar({
    sessionId: "satelles-child",
    concordia: { chat: async () => ({}), report: async () => ({}), patchSession: async () => undefined },
    requestShutdown: () => undefined,
    runtimeModelEffort: state,
  });
  const url = `http://127.0.0.1:${sidecar.port}/v1/runtime/model-effort`;
  try {
    const browser = await fetch(url, {
      method: "POST",
      headers: { origin: "https://example.invalid" },
      body: JSON.stringify({ model: "gpt-5.5", effort: "xhigh" }),
    });
    assert.equal(browser.status, 403);
    assert.deepEqual(state.forNextTurn(), { model: null, effort: null });
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ model: "gpt-5.5", effort: "xhigh" }) });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
    assert.deepEqual(state.forNextTurn(), { model: "gpt-5.5", effort: "xhigh" });
  } finally { await sidecar.close(); }
});

test("sidecar port is published under its own metadata key, best-effort", async () => {
  const patches: unknown[] = [];
  assert.equal(await publishSidecarPort({ patchSession: async (id, patch) => { patches.push({ id, patch }); } }, "s1", 4321, () => undefined), true);
  assert.deepEqual(patches, [{ id: "s1", patch: { metadata: { [SATELLES_SIDECAR_PORT_KEY]: 4321 } } }]);
  assert.equal(SATELLES_SIDECAR_PORT_KEY === "lictor_port", false);
  const logs: string[] = [];
  assert.equal(await publishSidecarPort({ patchSession: async () => { throw new Error("down"); } }, "s1", 1, (m) => logs.push(m)), false);
  assert.equal(logs.length, 1);
});

/** Minimal app-server that completes every turn and records turn/start params. */
function recordingAppServer(turnStarts: Array<Record<string, unknown>>): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  let exited = false;
  Object.assign(child, {
    stdin, stdout, stderr, pid: 4343,
    kill: () => {
      if (exited) return true;
      exited = true;
      stdin.end(); stdout.end(); stderr.end();
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`); };
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) continue;
      if (message.method === "account/read") {
        send({ jsonrpc: "2.0", id: message.id, result: { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: false } });
      } else if (message.method === "thread/start") {
        send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-rme", sessionId: "session-rme" } } });
        send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread-rme", sessionId: "session-rme" } } });
      } else if (message.method === "turn/start") {
        turnStarts.push(message.params ?? {});
        const turnId = `turn-${turnStarts.length}`;
        send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-rme", turn: { id: turnId, status: "completed" } } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    }
  });
  return child;
}

test("a switch received between turns is sent on the next turn/start, not before", async () => {
  const turnStarts: Array<Record<string, unknown>> = [];
  const state = new RuntimeModelEffortState();
  const session = await SatellesCodexSession.start({
    binary: "codex",
    cwd: process.cwd(),
    env: process.env,
    sink: new VolatileTranscriptSink(),
    clientVersion: "test",
    spawnProcess: () => recordingAppServer(turnStarts),
  });
  try {
    await session.runTurn({ prompt: "first", cwd: process.cwd(), ...state.forNextTurn() });
    state.apply({ model: "gpt-5.5", effort: "high" });
    await session.runTurn({ prompt: "second", cwd: process.cwd(), ...state.forNextTurn() });
    assert.equal(turnStarts.length, 2);
    assert.equal("effort" in turnStarts[0], false);
    assert.equal("model" in turnStarts[0], false);
    assert.equal(turnStarts[1].effort, "high");
    assert.equal(turnStarts[1].model, "gpt-5.5");
  } finally {
    session.terminate();
  }
});
