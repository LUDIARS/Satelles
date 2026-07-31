/**
 * inject が人間由来か自動由来かの判別。
 *
 * ask マーカーの回答待ちで効く: Concordia は作業ポリシーや nudge を
 * `session.inject` として自動注入するので、それを回答として消費すると
 * 人間の答えを待たずにターンが進む (2026-07-30 Delegation Test run ea083871)。
 *
 * 判別素材は Concordia の `session.inject` イベントの `source`。人間の発言は
 * `discord:<userId>:...` / `slack:<userId>:...`、あるいは CLI 直 inject の
 * source なし。自動注入は用途を表す prefix (`auto:` / `session-start:` 等) か
 * 既知の固定文字列を名乗る。Concordia 側の語彙が正本なので、増えたら
 * ここに足す (未知の source は人間側に倒す — 人間の回答を取りこぼすより、
 * 自動注入を 1 回回答扱いする方が復帰しやすい)。
 */

/** 自動注入だけが使う source prefix (`<prefix>:` 形式)。 */
const AUTOMATION_PREFIXES = new Set([
  "auto",
  "session-start",
  "delegation",
  "taskflow",
  "system",
  "admin",
  "revisor",
]);

/**
 * prefix を持たない、固定文字列の自動注入。
 * `<source>:<詳細>` と後続要素を足した形も同じ扱いにする
 * (例: `discord:cc-skill:<channel>:<message>`)。
 */
const AUTOMATION_SOURCES = new Set([
  "cc-skill",
  // skill 注入は platform を名乗るが人間ではない (Cc `api/sessions/skills.ts`)。
  "discord:cc-skill",
  "slack:cc-skill",
  "initial-work",
  "auto-baseline",
  "discord-enter-fallback",
  "admin-stop-session",
]);

/**
 * この inject を ask の回答として採用してよいか。
 *
 * `null` / 空 (CLI からの直 inject) は人間扱い。判別できない未知の source も
 * 人間扱いにして、従来どおりの寛容さを保つ。
 */
export function isHumanInject(source: string | null | undefined): boolean {
  const raw = typeof source === "string" ? source.trim() : "";
  if (!raw) return true;
  for (const known of AUTOMATION_SOURCES) {
    if (raw === known || raw.startsWith(`${known}:`)) return false;
  }
  const colon = raw.indexOf(":");
  const prefix = colon >= 0 ? raw.slice(0, colon) : raw;
  return !AUTOMATION_PREFIXES.has(prefix);
}
