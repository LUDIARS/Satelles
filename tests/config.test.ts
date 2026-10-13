import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConfigOverrides,
  MAX_INTERACTIVE_STALL_TIMEOUT_MS,
  parseRunConfig,
} from "../src/config.js";

const THIS_FILE = fileURLToPath(import.meta.url);

const BARE_ENV = {} as NodeJS.ProcessEnv;

test("parseRunConfig: one-shot はプロンプト必須", () => {
  const { errors } = parseRunConfig([], BARE_ENV);
  assert.ok(errors.some((e) => e.includes("one-shot mode requires")));
});

test("parseRunConfig: --prompt / --model / --effort / --session-id を読む", () => {
  const { config, errors } = parseRunConfig(
    ["--prompt", "do it", "--model", "gpt-5.6-sol", "--effort", "xhigh", "--session-id", "satelles-x"],
    BARE_ENV,
  );
  assert.deepEqual(errors, []);
  assert.equal(config.taskPrompt, "do it");
  assert.equal(config.model, "gpt-5.6-sol");
  assert.equal(config.effort, "xhigh");
  assert.equal(config.sessionId, "satelles-x");
  assert.equal(config.interactive, false);
});

test("parseRunConfig: 不正な --effort はエラー", () => {
  const { errors } = parseRunConfig(["--prompt", "x", "--effort", "hyper"], BARE_ENV);
  assert.ok(errors.some((e) => e.includes("invalid --effort")));
});

test("parseRunConfig: CONCORDIA_DELEGATION_PROMPT_FILE が --prompt-file より優先", () => {
  const dir = mkdtempSync(join(tmpdir(), "satelles-config-"));
  try {
    const delegated = join(dir, "delegated.md");
    const local = join(dir, "local.md");
    writeFileSync(delegated, "delegated prompt");
    writeFileSync(local, "local prompt");
    const { config, errors } = parseRunConfig(
      ["--prompt-file", local],
      { CONCORDIA_DELEGATION_PROMPT_FILE: delegated, CONCORDIA_DELEGATION_RUN_ID: "run-1" } as NodeJS.ProcessEnv,
    );
    assert.deepEqual(errors, []);
    assert.equal(config.taskPrompt, "delegated prompt");
    assert.equal(config.delegationRunId, "run-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseRunConfig: --interactive はプロンプト無しを許す", () => {
  const { config, errors } = parseRunConfig(["--interactive"], BARE_ENV);
  assert.deepEqual(errors, []);
  assert.equal(config.interactive, true);
  assert.equal(config.taskPrompt, null);
});

test("parseRunConfig: 未知引数はエラー", () => {
  const { errors } = parseRunConfig(["--prompt", "x", "--bogus"], BARE_ENV);
  assert.ok(errors.some((e) => e.includes("unknown argument")));
});

test("buildConfigOverrides: model / effort を codex -c 形式へ (引用符なしの raw literal)", () => {
  assert.deepEqual(buildConfigOverrides({ model: null, effort: null }), []);
  // 引用符を付けると Windows cmd 経路の unsafe 文字チェックに落ちる (2026-07-30 実害)。
  assert.deepEqual(
    buildConfigOverrides({ model: "gpt-5.6-sol", effort: "xhigh" }),
    ["model=gpt-5.6-sol", "model_reasoning_effort=xhigh"],
  );
});

test("buildConfigOverrides: 公開 API 直呼びでも不正値は `-c` へ渡さない", () => {
  // parseRunConfig を経由しない呼び出し (index.ts の公開 export) でも
  // 引用符なし raw literal の前提を破らせない。
  assert.throws(() => buildConfigOverrides({ model: 'bad"model', effort: null }), /unsafe model id/);
  assert.throws(
    () => buildConfigOverrides({ model: null, effort: "hyper" }),
    /unsafe reasoning effort/,
  );
});

test("parseRunConfig: serve は既定で 5 分の無進捗上限を持つ", () => {
  const { config, errors } = parseRunConfig(["--interactive"], BARE_ENV);
  assert.deepEqual(errors, []);
  assert.equal(config.stallTimeoutMs, MAX_INTERACTIVE_STALL_TIMEOUT_MS);
});

test("parseRunConfig: 無進捗上限は 5 分以下でのみ変更できる", () => {
  const { config, errors } = parseRunConfig(
    ["--interactive", "--stall-timeout-ms", "120000"],
    BARE_ENV,
  );
  assert.deepEqual(errors, []);
  assert.equal(config.stallTimeoutMs, 120_000);

  const invalid = parseRunConfig(["--interactive", "--stall-timeout-ms", "300001"], BARE_ENV);
  assert.ok(invalid.errors.some((e) => e.includes("invalid --stall-timeout-ms")));
});

test("parseRunConfig: 委託 run は無進捗・絶対どちらの期限も持たない", () => {
  const { config, errors } = parseRunConfig([], {
    CONCORDIA_DELEGATION_PROMPT_FILE: THIS_FILE,
    CONCORDIA_DELEGATION_RUN_ID: "run-no-timeout",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(errors, []);
  assert.equal(config.stallTimeoutMs, null);
  assert.equal(config.turnTimeoutMs, null);
});

test("parseRunConfig: 委託 run への明示タイムアウト指定は拒否する", () => {
  const { errors } = parseRunConfig(["--turn-timeout-ms", "1000"], {
    CONCORDIA_DELEGATION_PROMPT_FILE: THIS_FILE,
    CONCORDIA_DELEGATION_RUN_ID: "run-explicit-timeout",
  } as NodeJS.ProcessEnv);
  assert.ok(errors.some((e) => e.includes("TaskWorkflow runs do not accept turn timeouts")));
});

test("parseRunConfig: one-shot は無進捗上限を持たない (絶対上限のみ)", () => {
  const { config } = parseRunConfig(["--prompt", "do it"], BARE_ENV);
  assert.equal(config.stallTimeoutMs, null);
});

test("parseRunConfig: 不正文字を含む --model はエラー", () => {
  const { errors } = parseRunConfig(["--prompt", "x", "--model", 'bad"model'], BARE_ENV);
  assert.ok(errors.some((e) => e.includes("invalid --model")));
});

test("parseRunConfig: SATELLES_CODEX_RUNTIME 既定は native、WSL 補助 env も既定値を持つ", () => {
  const { config, errors } = parseRunConfig(["--prompt", "x"], BARE_ENV);
  assert.deepEqual(errors, []);
  assert.equal(config.codexRuntime, "native");
  assert.equal(config.wslDistro, "Ubuntu");
  assert.equal(config.wslUser, "ubuntu");
  assert.equal(config.wslCodexBinary, "codex");
});

test("parseRunConfig: SATELLES_CODEX_RUNTIME=wsl と WSL 補助 env を読む", () => {
  const { config, errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_RUNTIME: "wsl",
    SATELLES_WSL_DISTRO: "Debian",
    SATELLES_WSL_USER: "coder",
    SATELLES_WSL_CODEX_BINARY: "/home/coder/.local/bin/codex",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(errors, []);
  assert.equal(config.codexRuntime, "wsl");
  assert.equal(config.wslDistro, "Debian");
  assert.equal(config.wslUser, "coder");
  assert.equal(config.wslCodexBinary, "/home/coder/.local/bin/codex");
});

test("parseRunConfig: SATELLES_CODEX_SANDBOX 既定は workspace-write", () => {
  const { config, errors } = parseRunConfig(["--prompt", "x"], BARE_ENV);
  assert.deepEqual(errors, []);
  assert.equal(config.codexSandbox, "workspace-write");
});

test("parseRunConfig: SATELLES_CODEX_SANDBOX=danger-full-access を読む", () => {
  const { config, errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_SANDBOX: "danger-full-access",
    CONCORDIA_DELEGATION_RUN_ID: "run-trusted-local",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(errors, []);
  assert.equal(config.codexSandbox, "danger-full-access");
});

test("parseRunConfig: danger-full-access は Cc 起動の印が無ければ拒否する", () => {
  const { errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_SANDBOX: "danger-full-access",
  } as NodeJS.ProcessEnv);
  assert.ok(errors.some((e) => e.includes("requires CONCORDIA_DELEGATION_RUN_ID or CONCORDIA_SPAWN_ID")));
});

test("parseRunConfig: danger-full-access は Cc spawn の対話 serve でも読む", () => {
  const { config, errors } = parseRunConfig(["--interactive"], {
    SATELLES_CODEX_SANDBOX: "danger-full-access",
    CONCORDIA_SPAWN_ID: "spawn-forum-1",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(errors, []);
  assert.equal(config.interactive, true);
  assert.equal(config.codexSandbox, "danger-full-access");
  assert.equal(config.spawnEnrollment, "spawn-forum-1");
});

test("parseRunConfig: danger-full-access は WSL runtime では拒否する", () => {
  const { errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_RUNTIME: "wsl",
    SATELLES_CODEX_SANDBOX: "danger-full-access",
    CONCORDIA_DELEGATION_RUN_ID: "run-trusted-local",
  } as NodeJS.ProcessEnv);
  assert.ok(errors.some((e) => e.includes("requires SATELLES_CODEX_RUNTIME=native")));
});

test("parseRunConfig: 不正な SATELLES_CODEX_SANDBOX はエラー (既定へ黙って落とさない)", () => {
  const { errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_SANDBOX: "read-only",
  } as NodeJS.ProcessEnv);
  assert.ok(errors.some((e) => e.includes("invalid SATELLES_CODEX_SANDBOX")));
});

test("parseRunConfig: 不正な SATELLES_CODEX_RUNTIME はエラー (runner 内 throw にしない)", () => {
  const { errors } = parseRunConfig(["--prompt", "x"], {
    SATELLES_CODEX_RUNTIME: "docker",
  } as NodeJS.ProcessEnv);
  assert.ok(errors.some((e) => e.includes("invalid SATELLES_CODEX_RUNTIME")));
});

test("parseRunConfig: env 経路の不正値も CLI エラーにする (runner 内 throw にしない)", () => {
  // 素通しすると buildConfigOverrides が runner の途中で throw し、
  // ユーザに stack trace が出る。
  const bad = parseRunConfig(["--prompt", "x"], {
    SATELLES_MODEL: 'bad"model',
    SATELLES_EFFORT: "hyper",
  } as NodeJS.ProcessEnv);
  assert.ok(bad.errors.some((e) => e.includes("invalid SATELLES_MODEL")));
  assert.ok(bad.errors.some((e) => e.includes("invalid SATELLES_EFFORT")));
  assert.equal(bad.config.model, null);
  assert.equal(bad.config.effort, null);

  const ok = parseRunConfig(["--prompt", "x"], {
    SATELLES_MODEL: "gpt-5.6-sol",
    SATELLES_EFFORT: "high",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(buildConfigOverrides(ok.config), [
    "model=gpt-5.6-sol",
    "model_reasoning_effort=high",
  ]);

  // CLI 指定は env より優先される (検証は CLI 値に対して行う)。
  const cliWins = parseRunConfig(["--prompt", "x", "--model", "gpt-5.6-pro"], {
    SATELLES_MODEL: 'bad"model',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cliWins.errors, []);
  assert.equal(cliWins.config.model, "gpt-5.6-pro");
});
