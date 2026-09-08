import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { startSessionSidecar } from "../src/session-sidecar.js";
import { SessionSidecarRoutes } from "../src/session-sidecar-routes.js";

/** Send a literal request line + headers and read back the HTTP status code. */
function rawStatus(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(request));
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { received += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1];
      if (status) resolve(Number(status));
      else reject(new Error(`no HTTP status in response: ${received.slice(0, 120)}`));
    });
  });
}

function fixture() {
  const calls: unknown[] = [];
  let shutdowns = 0;
  const options = {
    sessionId: "satelles-child",
    concordia: {
      chat: async (id: string, body: unknown) => { calls.push({ id, body }); return { message: { id: 1 } }; },
      report: async (id: string, text: string) => { calls.push({ id, text }); return { ok: true }; },
      patchSession: async (id: string, patch: unknown) => { calls.push({ id, patch }); },
    },
    requestShutdown: () => { shutdowns++; },
  };
  return { options, calls, shutdowns: () => shutdowns };
}

test("chat strips supplied identity/destination and binds the worker session", async () => {
  const f = fixture();
  const routes = new SessionSidecarRoutes(f.options);
  const reply = await routes.handle("POST", "/v1/chat", {
    channel: "ぼやき", text: "報告です", session_id: "parent", discord_channel_id: "elsewhere",
    author_label: "someone else", metadata: { discord_channel_id: "elsewhere" },
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(f.calls, [{ id: "satelles-child", body: { channel: "ぼやき", text: "報告です" } }]);
  assert.equal((await routes.handle("POST", "/v1/chat", { channel: "ぼやき" })).status, 400);
  assert.equal((await routes.handle("POST", "/v1/unknown", {})).status, 404);
});

test("task updates and reports cannot target a caller-selected session", async () => {
  const f = fixture();
  const routes = new SessionSidecarRoutes(f.options);
  await routes.handle("POST", "/v1/lictor/task", { desc: "巡回", branch: "main", session_id: "parent" });
  await routes.handle("POST", "/v1/report", { monologue: "完了", session_id: "parent" });
  assert.deepEqual(f.calls, [
    { id: "satelles-child", patch: { branch: "main", current_task: "巡回" } },
    { id: "satelles-child", text: "完了" },
  ]);
});

test("shutdown is deferred until its response is flushed", async () => {
  const f = fixture();
  const reply = await new SessionSidecarRoutes(f.options).handle("POST", "/v1/shutdown", {});
  assert.equal(f.shutdowns(), 0);
  reply.afterResponse?.();
  assert.equal(f.shutdowns(), 1);
});

test("file delivery uses system channel and the current session; destinations cannot be supplied", async () => {
  const f = fixture();
  await new SessionSidecarRoutes(f.options).handle("POST", "/v1/internal/send-file", {
    files: ["E:/Document/Ars/report.txt"], caption: "調査資料", session_id: "parent", channel: "報告",
  });
  assert.deepEqual(f.calls, [{ id: "satelles-child", body: {
    channel: "system", text: "調査資料", attachment_paths: ["E:/Document/Ars/report.txt"],
  } }]);
});

test("HTTP listener provides identity, rejects browser/invalid input, surfaces failures, and closes", async () => {
  const f = fixture();
  f.options.concordia.report = async () => { throw new Error("private upstream details"); };
  const sidecar = await startSessionSidecar(f.options);
  const base = `http://127.0.0.1:${sidecar.port}`;
  try {
    const identity = await fetch(`${base}/v1/concordia/session`).then((r) => r.json()) as { session_id: string };
    assert.equal(identity.session_id, "satelles-child");
    assert.equal((await fetch(`${base}/v1/health`, { headers: { origin: "https://example.invalid" } })).status, 403);
    // undici drops a caller-supplied Host header, so the rebinding guard needs a raw request.
    assert.equal(await rawStatus(sidecar.port, "GET /v1/health HTTP/1.1\r\nHost: example.invalid\r\n\r\n"), 403);
    assert.equal((await fetch(`${base}/v1/chat`, { method: "POST", body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/v1/chat`, { method: "POST", body: "x".repeat(65 * 1024) })).status, 413);
    const failure = await fetch(`${base}/v1/report`, { method: "POST", body: JSON.stringify({ monologue: "test" }) });
    assert.equal(failure.status, 502);
    assert.doesNotMatch(await failure.text(), /private upstream/);
    const shutdown = await fetch(`${base}/v1/shutdown`, { method: "POST" });
    assert.equal(shutdown.status, 200);
    await shutdown.text();
    assert.equal(f.shutdowns(), 1);
  } finally { await sidecar.close(); }
  await sidecar.close();
  await assert.rejects(fetch(`${base}/v1/health`));
});
