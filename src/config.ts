import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";

export type CodexRuntime = "native" | "wsl";

export interface SatellesRunConfig {
  /** Concordia session id (satelles-<uuid> / 委託時は env から引き継ぎ可)。 */
  sessionId: string;
  provider: string;
  cwd: string;
  host: string;
  codexBinary: string;
  /** codex 本体を Windows ネイティブ ("native") / WSL 内 Linux 版 ("wsl") のどちらで起動するか。 */
  codexRuntime: CodexRuntime;
  /** runtime="wsl" のときの `wsl.exe -d <distro>`。native では未使用。 */
  wslDistro: string;
  /** runtime="wsl" のときの `wsl.exe -u <user>`。native では未使用。 */
  wslUser: string;
  /** runtime="wsl" のとき WSL 内で解決する codex コマンド名。native では未使用。 */
  wslCodexBinary: string;
  model: string | null;
  effort: string | null;
  /** ターン 0 のタスクプロンプト。interactive serve では null 可。 */
  taskPrompt: string | null;
  /** 1 ターンで終了 (委託) か、inject を待ち続ける常駐か。 */
  interactive: boolean;
  networkAccess: boolean;
  skillsDir: string | null;
  memory: boolean;
  /** 絶対上限。null は無効 (委託 run の期限は TaskWorkflow が持つ)。 */
  turnTimeoutMs: number | null | undefined;
  /** 無進捗の上限。null は無効 (委託 run)。 */
  stallTimeoutMs: number | null;
  delegationRunId: string | null;
  spawnEnrollment: string | null;
}

export interface ParseCliResult {
  config: SatellesRunConfig;
  errors: string[];
}

const VALID_EFFORT = new Set(["minimal", "low", "medium", "high", "xhigh", "ultra"]);
/** codex model id に許す安全文字集合 (`-c model=` へ生値で渡すため)。 */
const MODEL_ID_RE = /^[A-Za-z0-9._:\/-]+$/;

/**
 * 無進捗上限の上限値。根拠は対話セッション — 人間が Discord の前で待つ
 * 時間なので、これ以上は引き伸ばせない。
 *
 * なお `--stall-timeout-ms` の検証はモードを問わずこの上限で行う
 * (one-shot でも 5 分超は受け付けない)。one-shot / 委託 run の既定は
 * 「無進捗上限なし」で、長時間の無音が正当な用途はそちらを使う。
 */
export const MAX_INTERACTIVE_STALL_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_INTERACTIVE_STALL_TIMEOUT_MS = MAX_INTERACTIVE_STALL_TIMEOUT_MS;

/**
 * CLI 引数 + env から実行設定を組み立てる。
 *
 * 委託互換: `CONCORDIA_DELEGATION_PROMPT_FILE` (Cc がレンダリング済み prompt.md を
 * 置く) と `CONCORDIA_DELEGATION_RUN_ID` を Lictor と同じ契約で受ける。
 */
export function parseRunConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParseCliResult {
  const errors: string[] = [];
  let cwd = process.cwd();
  let model: string | null = null;
  let effort: string | null = null;
  let promptFile: string | null = null;
  let promptInline: string | null = null;
  let sessionId: string | null = null;
  let interactive = false;
  let networkAccess = false;
  let skillsDir: string | null = env.SATELLES_SKILLS_DIR?.trim() || null;
  let memory = env.SATELLES_MEMORY !== "0";
  let requestedTurnTimeoutMs: number | undefined;
  let requestedStallTimeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        errors.push(`${arg} requires a value`);
        return null;
      }
      i++;
      return value;
    };
    switch (arg) {
      case "--cwd": {
        const v = next();
        if (v !== null) cwd = v;
        break;
      }
      case "--model": {
        const v = next();
        if (v !== null) {
          if (!MODEL_ID_RE.test(v)) errors.push(`invalid --model: ${v}`);
          else model = v;
        }
        break;
      }
      case "--effort": {
        const v = next();
        if (v !== null) {
          if (!VALID_EFFORT.has(v)) errors.push(`invalid --effort: ${v}`);
          else effort = v;
        }
        break;
      }
      case "--prompt-file":
      case "-p": {
        promptFile = next();
        break;
      }
      case "--prompt": {
        promptInline = next();
        break;
      }
      case "--session-id": {
        sessionId = next();
        break;
      }
      case "--interactive":
      case "--serve": {
        interactive = true;
        break;
      }
      case "--network": {
        networkAccess = true;
        break;
      }
      case "--skills-dir": {
        skillsDir = next();
        break;
      }
      case "--no-memory": {
        memory = false;
        break;
      }
      case "--turn-timeout-ms": {
        const v = next();
        if (v !== null) {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) errors.push(`invalid --turn-timeout-ms: ${v}`);
          else requestedTurnTimeoutMs = n;
        }
        break;
      }
      case "--stall-timeout-ms": {
        const v = next();
        if (v !== null) {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0 || n > MAX_INTERACTIVE_STALL_TIMEOUT_MS) {
            errors.push(
              `invalid --stall-timeout-ms: ${v} (must be 1-${MAX_INTERACTIVE_STALL_TIMEOUT_MS})`,
            );
          } else {
            requestedStallTimeoutMs = n;
          }
        }
        break;
      }
      default:
        errors.push(`unknown argument: ${arg}`);
    }
  }

  // 委託互換: Cc の delegation prompt file が最優先。
  const delegationPromptFile = env.CONCORDIA_DELEGATION_PROMPT_FILE?.trim() || null;
  let taskPrompt: string | null = null;
  const effectivePromptFile = delegationPromptFile ?? promptFile;
  if (effectivePromptFile) {
    try {
      taskPrompt = readFileSync(effectivePromptFile, "utf8");
    } catch (error) {
      errors.push(`failed to read prompt file ${effectivePromptFile}: ${(error as Error).message}`);
    }
  } else if (promptInline !== null) {
    taskPrompt = promptInline;
  }
  if (taskPrompt !== null && !taskPrompt.trim()) {
    errors.push("prompt is empty");
    taskPrompt = null;
  }
  if (!interactive && taskPrompt === null) {
    errors.push("one-shot mode requires --prompt-file / --prompt (or CONCORDIA_DELEGATION_PROMPT_FILE)");
  }

  // 期限のポリシー。対話は人間が待つので短い無進捗上限を既定で持ち、委託 run は
  // 長時間処理そのものが仕事なので Satelles 側の期限を一切かけない (期限は
  // TaskWorkflow が持つ)。one-shot は絶対上限のみ。
  const delegationRunId = env.CONCORDIA_DELEGATION_RUN_ID?.trim() || null;
  let turnTimeoutMs: number | null | undefined = requestedTurnTimeoutMs;
  let stallTimeoutMs: number | null =
    requestedStallTimeoutMs ?? (interactive ? DEFAULT_INTERACTIVE_STALL_TIMEOUT_MS : null);
  if (delegationRunId) {
    if (requestedTurnTimeoutMs !== undefined || requestedStallTimeoutMs !== undefined) {
      errors.push("TaskWorkflow runs do not accept turn timeouts");
    }
    turnTimeoutMs = null;
    stallTimeoutMs = null;
  }

  // env 経路も CLI と同じ検証をかける。ここを素通しすると buildConfigOverrides が
  // runner の途中で throw し、ユーザに stack trace が出る (CLI エラーで落ちない)。
  let resolvedModel = model;
  if (resolvedModel === null) {
    const v = env.SATELLES_MODEL?.trim() || null;
    if (v !== null) {
      if (!MODEL_ID_RE.test(v)) errors.push(`invalid SATELLES_MODEL: ${v}`);
      else resolvedModel = v;
    }
  }
  let resolvedEffort = effort;
  if (resolvedEffort === null) {
    const v = env.SATELLES_EFFORT?.trim() || null;
    if (v !== null) {
      if (!VALID_EFFORT.has(v)) errors.push(`invalid SATELLES_EFFORT: ${v}`);
      else resolvedEffort = v;
    }
  }

  const rawRuntime = env.SATELLES_CODEX_RUNTIME?.trim() || "native";
  let codexRuntime: CodexRuntime = "native";
  if (rawRuntime === "native" || rawRuntime === "wsl") {
    codexRuntime = rawRuntime;
  } else {
    errors.push(`invalid SATELLES_CODEX_RUNTIME: ${rawRuntime} (must be native or wsl)`);
  }

  const config: SatellesRunConfig = {
    sessionId: sessionId ?? env.SATELLES_SESSION_ID?.trim() ?? `satelles-${randomUUID()}`,
    provider: "codex-sdk",
    cwd,
    host: hostname(),
    codexBinary: env.SATELLES_CODEX_BINARY?.trim() || "codex",
    codexRuntime,
    wslDistro: env.SATELLES_WSL_DISTRO?.trim() || "Ubuntu",
    wslUser: env.SATELLES_WSL_USER?.trim() || "ubuntu",
    wslCodexBinary: env.SATELLES_WSL_CODEX_BINARY?.trim() || "codex",
    model: resolvedModel,
    effort: resolvedEffort,
    taskPrompt,
    interactive,
    networkAccess,
    skillsDir,
    memory,
    turnTimeoutMs,
    stallTimeoutMs,
    delegationRunId,
    spawnEnrollment: env.CONCORDIA_SPAWN_ID?.trim() || null,
  };
  return { config, errors };
}

/**
 * model / effort を `codex -c` override 文字列列へ変換する。
 *
 * 値は引用符を付けず生で渡す。codex の `-c` は TOML パース失敗時に raw 文字列
 * literal として扱うため引用符は不要で、引用符を付けると Windows cmd 経路の
 * unsafe 文字チェック (`"` 拒否) に自爆する (2026-07-30 実害: spawn 即死)。
 * 値の安全性は parseRunConfig が CLI / env 両経路の解決後の値に対して担保するが、
 * この関数は公開 API (index.ts) でもあるため、同じ条件をここでも再確認する
 * (model=MODEL_ID_RE / effort=VALID_EFFORT)。
 */
export function buildConfigOverrides(config: Pick<SatellesRunConfig, "model" | "effort">): string[] {
  const overrides: string[] = [];
  if (config.model) {
    if (!MODEL_ID_RE.test(config.model)) throw new Error(`unsafe model id: ${config.model}`);
    overrides.push(`model=${config.model}`);
  }
  if (config.effort) {
    if (!VALID_EFFORT.has(config.effort)) throw new Error(`unsafe reasoning effort: ${config.effort}`);
    overrides.push(`model_reasoning_effort=${config.effort}`);
  }
  return overrides;
}
