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

test("buildConfigOverrides: model / effort を codex -c 形式へ", () => {
  assert.deepEqual(buildConfigOverrides({ model: null, effort: null }), []);
  assert.deepEqual(
    buildConfigOverrides({ model: "gpt-5.6-sol", effort: "xhigh" }),
    ['model="gpt-5.6-sol"', 'model_reasoning_effort="xhigh"'],
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
