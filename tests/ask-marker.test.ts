import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskMarkerText, extractOptions } from "../src/ask-marker.js";
import { stripAskBlock } from "../src/ask-json.js";

const ASK_BLOCK = [
  "調査が終わりました。判断をお願いします。",
  "",
  "```ask",
  '{"question":"どちらで進めますか？","multiSelect":false,"options":[{"label":"A案","description":"最速"},{"label":"B案"}]}',
  "```",
  "",
  "以上です。",
].join("\n");

test("parseAskMarkerText: 正常な ask ブロックを構造化する", () => {
  const ask = parseAskMarkerText(ASK_BLOCK);
  assert.ok(ask);
  assert.equal(ask.question, "どちらで進めますか？");
  assert.equal(ask.multiSelect, false);
  assert.deepEqual(ask.options, [
    { label: "A案", description: "最速" },
    { label: "B案" },
  ]);
});

test("parseAskMarkerText: マーカー無しは null", () => {
  assert.equal(parseAskMarkerText("ただのテキスト"), null);
  assert.equal(parseAskMarkerText("```json\n{}\n```"), null);
});

test("parseAskMarkerText: Windows パスの未エスケープ \\ を許容する (寛容パース)", () => {
  const text = [
    "```ask",
    '{"question":"E:\\Document\\Ars を対象にしますか？","multiSelect":false,"options":[{"label":"はい"},{"label":"いいえ"}]}',
    "```",
  ].join("\n");
  const ask = parseAskMarkerText(text);
  assert.ok(ask);
  assert.match(ask.question, /Document/);
});

test("parseAskMarkerText: options 空は null (質問カードにならない)", () => {
  const text = ["```ask", '{"question":"?","options":[]}', "```"].join("\n");
  assert.equal(parseAskMarkerText(text), null);
});

test("extractOptions: 文字列 / オブジェクト混在を正規化し順序を保存する", () => {
  const options = extractOptions(["A", { label: " B ", description: " d " }, { label: "" }, 42]);
  assert.deepEqual(options, [{ label: "A" }, { label: "B", description: "d" }]);
});

test("stripAskBlock: ask ブロックを除去して説明テキストだけ残す", () => {
  const stripped = stripAskBlock(ASK_BLOCK);
  assert.ok(!stripped.includes("```ask"));
  assert.ok(stripped.includes("調査が終わりました"));
  assert.ok(stripped.includes("以上です。"));
});
