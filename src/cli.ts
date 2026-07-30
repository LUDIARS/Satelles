import { parseRunConfig } from "./config.js";
import { runSatelles } from "./runner.js";
import { SATELLES_VERSION } from "./version.js";

const USAGE = `satelles ${SATELLES_VERSION} — SDK-style headless Codex agent runner

Usage:
  satelles run [options]        one-shot turn loop (delegation-compatible)
  satelles serve [options]      interactive resident session (waits for injects)

Options:
  --cwd <dir>              working directory (default: process cwd)
  --model <id>             codex model override (-c model=...)
  --effort <level>         minimal|low|medium|high|xhigh|ultra (-c model_reasoning_effort=...)
  --prompt-file, -p <path> first-turn task prompt file
  --prompt <text>          first-turn task prompt inline
  --session-id <id>        Concordia session id (default: satelles-<uuid>)
  --network                allow network access inside the sandbox
  --skills-dir <dir>       inject <dir>/<name>/SKILL.md (or <name>.md) as prompt preamble
  --no-memory              skip repo memory digest injection
  --turn-timeout-ms <n>    per-turn timeout (default 4h)

Env:
  CONCORDIA_DELEGATION_PROMPT_FILE  rendered delegation prompt (Cc contract; overrides --prompt-file)
  CONCORDIA_DELEGATION_RUN_ID       delegation run id (recorded in session metadata)
  CONCORDIA_HOST / CONCORDIA_PORT   Concordia address (default 127.0.0.1:11111)
  SATELLES_DISABLE_CONCORDIA=1      run standalone (no register / no relay)
  SATELLES_CODEX_BINARY             codex binary (default: codex)
  SATELLES_MODEL / SATELLES_EFFORT  defaults for --model / --effort
  SATELLES_SKILLS_DIR               default for --skills-dir
  SATELLES_MEMORY=0                 default for --no-memory
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version") {
    process.stdout.write(`${SATELLES_VERSION}\n`);
    return 0;
  }
  if (command !== "run" && command !== "serve") {
    process.stderr.write(`satelles: unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const args = command === "serve" ? [...rest, "--interactive"] : rest;
  const { config, errors } = parseRunConfig(args);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`satelles: ${error}\n`);
    return 2;
  }

  try {
    await runSatelles(config);
    return 0;
  } catch (error) {
    process.stderr.write(`satelles: ${(error as Error).message}\n`);
    return 1;
  }
}
