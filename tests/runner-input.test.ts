import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWsEvent, InputQueue, waitForAnswer } from "../src/runner.js";

const SID = "satelles-own";

test("shutdown wakes an ask wait without treating automated injects as human answers", async () => {
  const q = new InputQueue();
  q.push({ kind: "inject", text: "later", questionId: null, source: "auto:stall-nudge" });
  q.push({ kind: "shutdown", text: "", questionId: null, source: null });
  assert.equal(await waitForAnswer(q, 12), "");
  assert.equal((await q.take()).text, "later");
});

test("handleWsEvent: 自分宛 session.inject をキューへ", async () => {
  const q = new InputQueue();
  handleWsEvent({ type: "session.inject", target_session_id: SID, text: "hello" }, SID, q);
  const input = await q.take();
  assert.deepEqual(input, { kind: "inject", text: "hello", questionId: null, source: null });
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
  q.push({ kind: "inject", text: "sentinel", questionId: null, source: null });
});

test("handleWsEvent: question.answered は question_id 付きで届く", async () => {
  const q = new InputQueue();
  handleWsEvent(
    { type: "question.answered", target_session_id: SID, question_id: 12, answer_index: 0, answer_text: "A案" },
    SID,
    q,
  );
  const input = await q.take();
  assert.deepEqual(input, { kind: "answer", text: "A案", questionId: 12, source: null });
});

test("InputQueue: 待ち合わせ (take 先行 → push で解決)", async () => {
  const q = new InputQueue();
  const pending = q.take();
  q.push({ kind: "inject", text: "later", questionId: null, source: null });
  const input = await pending;
  assert.equal(input.text, "later");
});

test("waitForAnswer: 回答待ち中の自動 inject は回答にせず次ターンへ残す", async () => {
  const q = new InputQueue();
  const answered = waitForAnswer(q, 7);

  // Cc の作業ポリシー注入が先に届く (2026-07-30 の実害と同じ形)。
  q.push({ kind: "inject", text: "【Cc Session 作業ポリシー】…", questionId: null, source: "session-start:cc-workflow" });
  q.push({ kind: "inject", text: "nudge", questionId: null, source: "auto:stall-nudge" });

  let settled = false;
  void answered.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "自動 inject で回答待ちが解けてはいけない");

  // 人間のボタン回答が届いたらそれを採用する。
  q.push({ kind: "answer", text: "A案", questionId: 7, source: null });
  assert.equal(await answered, "A案");

  // 保留した自動 inject は到着順のまま次ターンの入力として残る。
  assert.equal((await q.take()).text, "【Cc Session 作業ポリシー】…");
  assert.equal((await q.take()).text, "nudge");
});

test("waitForAnswer: 人間の生テキスト inject は従来どおり回答になる", async () => {
  const q = new InputQueue();
  const answered = waitForAnswer(q, 12);
  q.push({ kind: "inject", text: "B でお願い", questionId: null, source: "discord:1234:c:m" });
  assert.equal(await answered, "B でお願い");
});

test("waitForAnswer: question_id 不一致の answer は捨てて待ち続ける", async () => {
  const q = new InputQueue();
  const answered = waitForAnswer(q, 3);
  q.push({ kind: "answer", text: "別の質問の答え", questionId: 99, source: null });
  q.push({ kind: "answer", text: "こっちの答え", questionId: 3, source: null });
  assert.equal(await answered, "こっちの答え");
});

test("handleWsEvent: session.inject の source をキューまで運ぶ", async () => {
  const q = new InputQueue();
  handleWsEvent(
    { type: "session.inject", target_session_id: SID, text: "policy", source: "session-start:cc-workflow" },
    SID,
    q,
  );
  const input = await q.take();
  assert.equal(input.source, "session-start:cc-workflow");
});
