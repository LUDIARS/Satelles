import assert from "node:assert/strict";
import test from "node:test";

import { NON_INTERACTIVE_ENV, buildCodexChildEnv } from "../src/child-env.js";

test("worker sidecar replaces parent identity including Windows case variants", () => {
  const base = { LICTOR_PORT: "1234", lictor_port: "4321", LICTOR_SESSION_ID: "parent" };
  const env = buildCodexChildEnv(base, { port: 54321, sessionId: "child" });
  assert.equal(env.LICTOR_PORT, "54321");
  assert.equal(env.LICTOR_SESSION_ID, "child");
  assert.equal(env.lictor_port, undefined);
  assert.equal(base.LICTOR_SESSION_ID, "parent");
  const standalone = buildCodexChildEnv(base);
  assert.equal(standalone.LICTOR_PORT, undefined);
  assert.equal(standalone.LICTOR_SESSION_ID, undefined);
});

test("非対話設定を親 env に重ねる", () => {
  const env = buildCodexChildEnv({ PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
    assert.equal(env[key], value, `${key} が非対話設定になっていない`);
  }
});

test("親 env の対話寄り設定を上書きする", () => {
  // 実害の出た組み合わせ: 対話プロンプトが有効なまま sandbox 内で git push。
  const env = buildCodexChildEnv({
    GIT_TERMINAL_PROMPT: "1",
    GCM_INTERACTIVE: "auto",
    GIT_ASKPASS: "C:/gui-askpass.exe",
  });
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.equal(env.GIT_ASKPASS, "echo");
});

test("親 env を破壊しない", () => {
  const base = { PATH: "/usr/bin" };
  buildCodexChildEnv(base);
  assert.deepEqual(base, { PATH: "/usr/bin" });
});

test("ssh 経路も BatchMode で止まらない", () => {
  const env = buildCodexChildEnv({});
  assert.match(String(env.GIT_SSH_COMMAND), /BatchMode=yes/);
  assert.equal(env.SSH_ASKPASS, "echo");
});

test("親の GIT_SSH_COMMAND は捨てずに BatchMode を足す", () => {
  const env = buildCodexChildEnv({ GIT_SSH_COMMAND: "ssh -i C:/keys/deploy" });
  assert.match(String(env.GIT_SSH_COMMAND), /-i C:\/keys\/deploy/);
  assert.match(String(env.GIT_SSH_COMMAND), /BatchMode=yes/);
});

test("親が既に BatchMode 指定済みなら二重に足さない", () => {
  const inherited = "ssh -o BatchMode=yes -i C:/keys/deploy";
  const env = buildCodexChildEnv({ GIT_SSH_COMMAND: inherited });
  assert.equal(env.GIT_SSH_COMMAND, inherited);
});
