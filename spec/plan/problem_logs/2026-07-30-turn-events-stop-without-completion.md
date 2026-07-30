# ターンのイベントが途絶えても 4 時間打ち切られない

- Date: 2026-07-30
- Status: fixed (this branch)
- Area: Satelles codex-session / runner (無進捗ウォッチドッグ)
- Severity: high — 停滞したセッションが「作業中」に見え続け、inject を消費しない

## Summary

`turn/started` の後 15 分でイベントが完全に途絶え、`turn/completed` が来ない
ターンが観測された。`runTurn` の唯一の打ち切り手段は絶対上限
(`--turn-timeout-ms`, 既定 4 時間) だけなので、runner は 4 時間 `runTurn` を
await したまま、`InputQueue` に積まれた inject を 1 本も消費できない。
Concordia 側では WS が生きているためセッションは `active` のまま = 人間から
「作業中」と区別が付かない。

関連: [git credential prompt hangs a Satelles turn forever](./2026-07-30-git-credential-prompt-hangs-turn.md)
は「そもそも止まらないようにする」側の修正。本件は「止まったら気付いて
手放す」側で、両方入れて二重防御にする。

## Fix

1. **無進捗ウォッチドッグ** (`src/codex-session.ts`)
   `RunTurnOptions.stallTimeoutMs` を追加 (`null` で無効)。`turn/start` が
   返った時点から計測を始め、束ねた thread の notification が 1 本来るたびに
   延長する。途絶えたら `CodexTurnError("codex_turn_stalled")` でターンを
   打ち切り、`onStall` で呼び出し側に通知する。絶対上限
   (`turnTimeoutMs`、こちらも `null` で無効) は最後の安全弁として残す。
2. **ゾンビイベントの隔離**
   打ち切った時点で app-server 側の turn はまだ生きている可能性があるため、
   その turn id を `abandonedTurnIds` に記録する。以降その turn の
   `item/completed` / `turn/completed` は転記面には出すが、現ターンの進捗・
   完了・`agentText` には一切数えない。これが無いと (a) 何もしていない次の
   ターンが即 `completed` で返る、(b) `codex_thread_mismatch` でセッション
   ごと落ちる、のどちらかになる。
3. **停滞の可視化と復帰** (`src/runner.ts`)
   停滞を Concordia へ `codex_turn_stalled` イベント + `current_task` の
   ⚠️ 表示として出す (best-effort)。interactive はターンを手放して次の入力
   から再開し、復帰時に警告を取り下げる (取り下げるのは実際に ⚠️ を出せた
   ときだけ — 出せていないのに patch すると無関係な `current_task` を潰す)。
   one-shot は従来どおり失敗させ、委託 run には `failed` を報告する。
4. **CLI / config** — 期限は用途で分ける (`src/config.ts` が正本)。
   - `serve` (interactive): `--stall-timeout-ms` 既定 5 分。人間が Discord の
     前で待つ時間なので、上限も 5 分 (`MAX_INTERACTIVE_STALL_TIMEOUT_MS`)。
     この上限はモードを問わず引数検証に効く。
   - one-shot: 無進捗上限は既定で持たない (絶対上限 `--turn-timeout-ms`
     既定 4 時間のみ)。明示指定はできる。
   - 委託 run (`CONCORDIA_DELEGATION_RUN_ID`): 無進捗・絶対どちらの期限も
     持たない (`null`)。長時間処理そのものが仕事で、期限は TaskWorkflow 側が
     持つ。期限フラグを明示すると設定エラーにする。

## Verification

- `tests/turn-stall.test.ts`: 偽 app-server (JSON-RPC を話す `PassThrough`
  ベースの子プロセス) でハンドシェイクだけ応答し、`turn/start` の後は沈黙
  させて incident を再現する。検証項目 —
  イベントが来ないターンを停滞として打ち切ること、停滞検知が絶対上限より
  手前で鳴ること、停滞しないターンを殺さないこと、停滞中の inject が順序
  どおり残ること、停滞後も同じ thread で次ターンを開始できること
  (= `turning` フラグを解放すること)、打ち切った turn の後追いイベントが
  次ターンに混ざらないこと。
- `tests/turn-stall-timer.test.ts`: 偽 scheduler で再武装 / 停止 / `null`
  (無期限モード) を確認する。
- `tests/config.test.ts`: 用途別の期限ポリシー (serve 既定 5 分・上限、
  one-shot は無進捗上限なし、委託 run は両方 null かつ明示指定を拒否)。
- `npm test` / `tsc --noEmit` clean。
- 未カバー: `src/runner.ts` の停滞復帰経路 (`reportStall` /
  `announceStall` / `clearStallNotice`、interactive の再開、one-shot の
  失敗終了) は `runSatelles` を回すハーネスが無く、自動テストが無い。
  Concordia の状態カードと Discord 転記に何が出るかは実機確認が要る。

## 補足 (レビュー時の判断)

- `completionPromise` は `turn/start` が返ってから初めて await される。その
  手前で停滞タイマや thread mismatch が reject するとハンドラ未装着のまま
  `unhandledRejection` になり、プロセスごと落ちる。生成直後に空の catch を
  付けて「処理済み」にしてある。
- `abandonedTurnIds` は、その turn の `turn/completed` を観測した時点で
  忘れる。ただしその後追いイベントは、ターン間 (notification listener を
  外している窓) に届くことがあり、その場合は忘れる契機が来ない。上限
  (`MAX_ABANDONED_TURN_IDS`) を置いて古いものから捨て、長寿命の
  interactive セッションで際限なく溜まらないようにしてある。
- ゾンビ判定は notification の `turnId` / `turn.id` を見る。`turn/completed`
  は必ず `turn.id` を持つので致命的な 2 つ ((a) 即 completed / (b)
  thread mismatch で落ちる) は防げる。`turnId` を持たない `item/completed`
  が実機で来た場合、そのテキストが次ターンの `agentText` に混ざる余地は
  残る (ask マーカー誤検出まで。セッションは落ちない)。
- serve の既定 5 分は、実測の無音区間 (15 分) より十分短く、かつ対話
  セッションが人間を待たせすぎない長さとして選んだ。長いターンで正当に
  無音が続く作業 (巨大ビルド等) は one-shot か TaskWorkflow 側で回す。
- 委託 run から Satelles 側の期限を全部外したので、停止しない委託 run を
  止めるのは TaskWorkflow の責務になった。Concordia 側に期限が無いと、
  以前は効いていた 4 時間の安全弁ごと消える点に注意。
