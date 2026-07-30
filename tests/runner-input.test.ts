import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWsEvent, InputQueue } from "../src/runner.js";

const SID = "satelles-own";

test("handleWsEvent: 自分宛 session.inject をキューへ", async () => {
  const q = new InputQueue();
  handleWsEvent({ type: "session.inject", target_session_id: SID, text: "hello" }, SID, q);
  const input = await q.take();
  assert.deepEqual(input, { kind: "inject", text: "hello", questionId: null });
});

test("handleWsEvent: 他セッション宛 / 空テキストは無視", () => {
  const q = new InputQueue();
  handleWsEvent({ type: "session.inject", target_session_id: "other", text: "x" }, SID, q);
  handleWsEvent({ type: "session.inject", target_session_id: SID, text: "" }, SID, q);
  handleWsEvent({ type: "question.answered", target_session_id: SID, question_id: "7" }, SID, q);
  handleWsEvent(null, SID, q);
  // キューが空のままであることを、待たずに確認するため push で先勝ちさせる。
  let resolved = false;
  void q.take().then(() => {
    resolved = true;
  });
  assert.equal(resolved, false);
  q.push({ kind: "inject", text: "sentinel", questionId: null });
});

test("handleWsEvent: question.answered は question_id 付きで届く", async () => {
  const q = new InputQueue();
  handleWsEvent(
    { type: "question.answered", target_session_id: SID, question_id: 12, answer_index: 0, answer_text: "A案" },
    SID,
    q,
  );
  const input = await q.take();
  assert.deepEqual(input, { kind: "answer", text: "A案", questionId: 12 });
});

test("InputQueue: 待ち合わせ (take 先行 → push で解決)", async () => {
  const q = new InputQueue();
  const pending = q.take();
  q.push({ kind: "inject", text: "later", questionId: null });
  const input = await pending;
  assert.equal(input.text, "later");
});
