/**
 * "Ask marker" — テキストベースの質問プロトコル (Lictor 発祥、Satelles 移植)。
 *
 * PTY を持たない SDK ランナーでは対話 picker が存在しないため、モデルに
 * ```ask + JSON のフェンスドブロックで質問をテキスト出力させ、構造化パースして
 * Concordia の pending-question パイプライン (Discord カード) に流す。
 * 回答は次ターンの user 入力として `turn/start` に渡す。
 *
 * マーカー形式 (assistant のテキスト出力中に 1 ブロック):
 *
 *   ```ask
 *   {"question":"...","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}
 *   ```
 */

import { extractAskJsonText, parseLenientJson } from "./ask-json.js";

export interface AskMarker {
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** 全 provider 共通のステアリング本文。プロンプト前置テキストとして注入する。 */
export const ASK_MARKER_COMMON = `# ユーザへの選択提示 (Satelles relay)

このセッションは Satelles (ヘッドレスランナー) 経由で実行され、リモート (Discord 等) から回答される可能性があります。ユーザに選択や判断を求めるときは次のテキストプロトコルを使ってください。

- 情報文字列 \`ask\` を付けたフェンスドコードブロックを**ちょうど1つ**出力し、JSON オブジェクトを1つ入れて、そのままターンを終了して返信を待ってください。形式:

\`\`\`ask
{"question":"<ユーザの言語での質問>","multiSelect":false,"options":[{"label":"<短いラベル>","description":"<任意の補足>"},{"label":"..."}]}
\`\`\`

- 複数選択を許す場合は "multiSelect": true にしてください。
- ユーザには常に暗黙の「その他 / 自由文」回答があります。"Other" を選択肢に足す必要はありません。自由文が妥当な場面ではそう促してください。
- ブロックを出したらターンを終了します。ユーザの次のメッセージ (ラベル / 複数ラベル / 自由文) が回答です。それに従って続行してください。
- 選択肢の無い純粋な自由質問は、ブロック無しで普通のテキストで尋ねてください。
- ラベルは短く、ニュアンスは "description" に入れてください。
`;

/**
 * 生テキストから ```ask ... ``` ブロックを取り出してパースする純関数。
 *
 * 抽出は brace マッチ ({@link extractAskJsonText})、パースは寛容版
 * ({@link parseLenientJson})。Windows パスの未エスケープバックスラッシュ・
 * 全角クォート区切り・末尾カンマ・文字列内の生制御文字を許容する。
 *
 * ```ask フェンスはあるのに JSON が取り出せない場合は無言で捨てず stderr に
 * `[ask-marker]` で記録する (質問が消える事故の可視化)。
 */
export function parseAskMarkerText(text: string): AskMarker | null {
  const raw = extractAskJsonText(text);
  if (raw === null) return null; // そもそも ask マーカーが無い → 静かに無視
  const obj = parseLenientJson(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    logAskMarkerFailure("json-unparseable", raw);
    return null;
  }
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!question) {
    logAskMarkerFailure("missing-question", raw);
    return null;
  }
  const options = extractOptions(obj.options);
  if (options.length === 0) {
    logAskMarkerFailure("no-options", raw);
    return null;
  }
  return { question, multiSelect: obj.multiSelect === true, options };
}

/**
 * `options` を label 付きオプションへ正規化する。各要素は `{label, description}`
 * または素の文字列。空 / 非文字列 label は捨てる。順序は保存する (answer-index →
 * label の対応が Concordia 側とずれないように)。
 */
export function extractOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; description?: string }> = [];
  for (const opt of raw) {
    if (typeof opt === "string") {
      const s = opt.trim();
      if (s) out.push({ label: s });
      continue;
    }
    if (opt && typeof opt === "object") {
      const label = (opt as { label?: unknown }).label;
      const description = (opt as { description?: unknown }).description;
      if (typeof label === "string" && label.trim()) {
        const normalized = label.trim();
        if (typeof description === "string" && description.trim()) {
          out.push({ label: normalized, description: description.trim() });
        } else {
          out.push({ label: normalized });
        }
      }
    }
  }
  return out;
}

function logAskMarkerFailure(reason: string, raw: string): void {
  try {
    const preview = raw.replace(/\s+/g, " ").slice(0, 160);
    process.stderr.write(`[ask-marker] dropped question (${reason}): ${preview}\n`);
  } catch {
    /* best-effort */
  }
}
