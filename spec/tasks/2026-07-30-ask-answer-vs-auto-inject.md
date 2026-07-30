---
task: ask-answer-vs-auto-inject
project: Satelles
kind: 実装
status: pending
created: 2026-07-30T09:00:00.000Z
source_session: lictor-747d1505-b6bf-4c9e-a545-cdd83526e330
memoria_task_id: 664
actio_task_id: null
memory_links: []
---
# ask 回答待ち中の自動 inject を回答として消費しない

## 目的

2026-07-30 の Delegation Test (run ea083871) で、ask マーカー質問の回答待ち中に
Concordia が自動注入する「Cc Session 作業ポリシー」inject が **回答として消費**され、
本来の人間回答を待たずにターンが進んだ。runner.ts の `waitForAnswer` が
「生テキスト inject は無条件で回答扱い」とする寛容さの副作用。

## 完了条件

- `session.inject` の `source` を InputQueue まで伝搬する。
- 回答待ち中、source が自動系 (`auto:*` / `delegation:*` / policy 注入等) の inject は
  回答にせず、通常入力として後続ターン用にキューへ残す。
- 人間由来 (source null / discord) の inject と `question.answered` (question_id 一致) のみ
  回答として採用する。
- 回帰テスト: 回答待ち中に auto inject → まだ待つ / 人間 inject → 回答になる。

## 備考

- 判別素材は Concordia 側 event の `source` 文字列。語彙は Cc `events.ts` を確認して列挙する。
