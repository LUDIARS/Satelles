import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";

export interface SatellesRunConfig {
  /** Concordia session id (satelles-<uuid> / 委託時は env から引き継ぎ可)。 */
  sessionId: string;
  provider: string;
  cwd: string;
  host: string;
  codexBinary: string;
  model: string | null;
  effort: string | null;
  /** ターン 0 のタスクプロンプト。interactive serve では null 可。 */
  taskPrompt: string | null;
  /** 1 ターンで終了 (委託) か、inject を待ち続ける常駐か。 */
  interactive: boolean;
  networkAccess: boolean;
  skillsDir: string | null;
  memory: boolean;
  turnTimeoutMs: number | undefined;
  delegationRunId: string | null;
  spawnEnrollment: string | null;
}

export interface ParseCliResult {
  config: SatellesRunConfig;
  errors: string[];
}

const VALID_EFFORT = new Set(["minimal", "low", "medium", "high", "xhigh", "ultra"]);

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
  let turnTimeoutMs: number | undefined;

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
        model = next();
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
          else turnTimeoutMs = n;
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

  const config: SatellesRunConfig = {
    sessionId: sessionId ?? env.SATELLES_SESSION_ID?.trim() ?? `satelles-${randomUUID()}`,
    provider: "codex-sdk",
    cwd,
    host: hostname(),
    codexBinary: env.SATELLES_CODEX_BINARY?.trim() || "codex",
    model: model ?? env.SATELLES_MODEL?.trim() ?? null,
    effort: effort ?? env.SATELLES_EFFORT?.trim() ?? null,
    taskPrompt,
    interactive,
    networkAccess,
    skillsDir,
    memory,
    turnTimeoutMs,
    delegationRunId: env.CONCORDIA_DELEGATION_RUN_ID?.trim() || null,
    spawnEnrollment: env.CONCORDIA_SPAWN_ID?.trim() || null,
  };
  return { config, errors };
}

/** model / effort を `codex -c` override 文字列列へ変換する。 */
export function buildConfigOverrides(config: Pick<SatellesRunConfig, "model" | "effort">): string[] {
  const overrides: string[] = [];
  if (config.model) overrides.push(`model=${JSON.stringify(config.model)}`);
  if (config.effort) overrides.push(`model_reasoning_effort=${JSON.stringify(config.effort)}`);
  return overrides;
}
