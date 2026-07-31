import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurnCompletion, parseTurnUsage } from "../src/codex-event-frames.js";

const THREAD = "thread-1";

function completed(params: Record<string, unknown>) {
  return { method: "turn/completed", params };
}

test("snake_case の usage を読む (実測の rollout 語彙)", () => {
  const usage = parseTurnUsage(
    completed({
      threadId: THREAD,
      turn: {
        id: "turn-1",
        status: "completed",
        usage: {
          input_tokens: 42554,
          cached_input_tokens: 20224,
          cache_write_input_tokens: 0,
          output_tokens: 227,
          reasoning_output_tokens: 80,
          total_tokens: 42781,
        },
      },
    }),
    THREAD,
  );
  assert.deepEqual(usage, {
    threadId: THREAD,
    turnId: "turn-1",
    inputTokens: 42554,
    cachedInputTokens: 20224,
    cacheWriteInputTokens: 0,
    outputTokens: 227,
    reasoningOutputTokens: 80,
    totalTokens: 42781,
  });
});

test("camelCase の usage も読む (実装差に耐える)", () => {
  const usage = parseTurnUsage(
    completed({ threadId: THREAD, turn: { id: "t", usage: { inputTokens: 5, outputTokens: 7 } } }),
    THREAD,
  );
  assert.equal(usage?.inputTokens, 5);
  assert.equal(usage?.outputTokens, 7);
  // 取れなかった項目は出さない (0 と混同しない)。
  assert.equal("cachedInputTokens" in (usage ?? {}), false);
});

test("params 直下の usage も拾う", () => {
  const usage = parseTurnUsage(
    completed({ threadId: THREAD, turn: { id: "t" }, usage: { input_tokens: 3 } }),
    THREAD,
  );
  assert.equal(usage?.inputTokens, 3);
});

test("usage が無い / 別 thread / 別イベントは null (無害スキップ)", () => {
  assert.equal(parseTurnUsage(completed({ threadId: THREAD, turn: { id: "t" } }), THREAD), null);
  assert.equal(
    parseTurnUsage(completed({ threadId: "other", turn: { id: "t", usage: { input_tokens: 1 } } }), THREAD),
    null,
  );
  assert.equal(
    parseTurnUsage({ method: "turn/started", params: { threadId: THREAD, turn: { id: "t" } } }, THREAD),
    null,
  );
});

test("トークンが 1 つも読めない usage は載せない", () => {
  assert.equal(
    parseTurnUsage(completed({ threadId: THREAD, turn: { id: "t", usage: { note: "n/a" } } }), THREAD),
    null,
  );
});

test("キャッシュ 0 は実測値として保持する", () => {
  const usage = parseTurnUsage(
    completed({ threadId: THREAD, turn: { id: "t", usage: { input_tokens: 10, cached_input_tokens: 0 } } }),
    THREAD,
  );
  assert.equal(usage?.cachedInputTokens, 0);
});

test("想定外の usage 形は turn/completed の検出を巻き添えにしない", () => {
  // usage の形を ParamsSchema で宣言すると、null や別の入れ子を返す実装差で
  // params 全体の parse が落ち、turn の完了検出まで死ぬ (turn が停滞で終わる)。
  const shapes: unknown[] = [
    null,
    "n/a",
    [{ input_tokens: 1 }],
    { last_token_usage: { input_tokens: 1 } },
    { input_tokens: "42554" },
  ];
  for (const shape of shapes) {
    const notification = completed({
      threadId: THREAD,
      turn: { id: "t", status: "completed", usage: shape },
    });
    assert.deepEqual(
      parseTurnCompletion(notification, THREAD),
      { threadId: THREAD, turnId: "t", status: "completed", errorMessage: null },
      `usage=${JSON.stringify(shape)} で完了検出が壊れた`,
    );
    assert.equal(parseTurnUsage(notification, THREAD), null);
  }
});

test("有限でない数値はコスト値として採らない", () => {
  assert.equal(
    parseTurnUsage(
      completed({ threadId: THREAD, turn: { id: "t", usage: { input_tokens: Number.NaN } } }),
      THREAD,
    ),
    null,
  );
});
