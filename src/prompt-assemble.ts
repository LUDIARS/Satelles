/**
 * ターン 0 のプロンプト前置テキストを組み立てる純関数。
 *
 * Codex には Claude の `--append-system-prompt-file` / skill ディレクトリ注入が
 * 無いため、ask マーカー規約・skill 本文・repo memory digest はすべて
 * 「最初の user 入力の前置テキスト」として畳み込む。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASK_MARKER_COMMON } from "./ask-marker.js";
import {
  findRepoMemories,
  memoryDirForCwd,
  renderMemoryDigest,
  repoLeafFromCwd,
} from "./memory-loader.js";

export interface SkillText {
  name: string;
  body: string;
}

const SKILL_BODY_CAP = 32 * 1024;
const MEMORY_DIGEST_CAP = 8 * 1024;

/**
 * skills ディレクトリ (`<dir>/<name>/SKILL.md` または `<dir>/<name>.md`) を
 * 読み込む。読めないもの・空・32KiB 超は捨てる (Lictor skill-injector と同じ上限)。
 */
export function loadSkillTexts(skillsDir: string | null): SkillText[] {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  const out: SkillText[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const entry of entries.sort()) {
    const full = join(skillsDir, entry);
    let body: string | null = null;
    let name = entry;
    try {
      if (statSync(full).isDirectory()) {
        const skillMd = join(full, "SKILL.md");
        if (existsSync(skillMd)) body = readFileSync(skillMd, "utf8");
      } else if (entry.endsWith(".md")) {
        name = entry.slice(0, -3);
        body = readFileSync(full, "utf8");
      }
    } catch {
      continue;
    }
    if (!body || !body.trim()) continue;
    if (Buffer.byteLength(body, "utf8") > SKILL_BODY_CAP) continue;
    out.push({ name, body: body.trim() });
  }
  return out;
}

export interface AssemblePreambleOptions {
  cwd: string;
  /** ask マーカー規約を含めるか (Concordia 連携時のみ意味がある)。 */
  askMarker: boolean;
  skills: SkillText[];
  /** memory digest を組むか。 */
  memory: boolean;
  /** テスト注入用 override。省略時は cwd から解決。 */
  memoryDir?: string;
}

/**
 * 前置テキストを組み立てる。空要素は落とし、何も無ければ空文字列。
 */
export function assemblePreamble(options: AssemblePreambleOptions): string {
  const sections: string[] = [];
  if (options.askMarker) sections.push(ASK_MARKER_COMMON.trim());
  for (const skill of options.skills) {
    sections.push(`# Skill: ${skill.name}\n\n${skill.body}`);
  }
  if (options.memory) {
    const memoryDir = options.memoryDir ?? memoryDirForCwd(options.cwd);
    const matches = findRepoMemories(memoryDir, repoLeafFromCwd(options.cwd));
    const digest = renderMemoryDigest(matches, MEMORY_DIGEST_CAP);
    if (digest.trim()) {
      sections.push(`# Repo memory (session context)\n\n${digest.trim()}`);
    }
  }
  return sections.join("\n\n---\n\n");
}

/** 前置テキスト + タスク本文を 1 本のターン入力へ結合する。 */
export function composeFirstTurnPrompt(preamble: string, taskPrompt: string): string {
  if (!preamble.trim()) return taskPrompt;
  return `${preamble.trim()}\n\n---\n\n${taskPrompt}`;
}
