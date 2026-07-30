# Satelles — 設計

## 位置づけ

Codex セッションの実行を「CLI + ウィンドウ + PTY + rollout tail」から
「`codex app-server` JSON-RPC 直結のヘッドレスループ」へ移す。Lictor で
delegation 限定で実証済みの app-server 経路 (Lictor #82/#84/#85) を、
対話 (multi-turn + Question 方式) まで拡張して独立リポに切り出したもの。

出自: Lictor の `codex-app-server-client / codex-session-bootstrap /
codex-event-frames / transcript-sink / ask-json / ask-marker / memory-loader`
を移植。Concordia / Discord 側の契約 (transcript-frame / pending-question /
session.inject / question.answered) は既存のまま利用し、**サーバ側変更ゼロ**で動く。

## プロセスモデル

```
satelles run/serve (node)
  └─ codex app-server --listen stdio:// (child, JSON-RPC JSONL)
       └─ thread 1 本 (thread/start で束縛、プロセス生存中は resume 不要)
```

- ターンは `turn/start` を直列に重ねる。並行ターンは持たない。
- codex 0.144.x の「ターン0 rollout 未書き込み → resume 死」バグは、
  プロセスを生かしたままにすることで構造的に回避 (Lictor が対話を legacy PTY に
  戻した理由そのものが消える)。
- rollout JSONL は codex が勝手に書くが、Satelles は一切読まない。
  discover / tail / originator 施錠 / subagent 除外はすべて不要。

## ターンループ (runner.ts)

```
register (POST /v1/sessions, provider="codex-sdk", wrapped_by="satelles")
open WS /ws?session=<id>&enrollment=<spawn-id>   … liveness + イベント受信
start app-server session (bootstrap: initialize → account/read → thread/start)
turn0 input = [ask マーカー規約 + skills + memory digest] --- taskPrompt
loop:
  runTurn → agentText
  ask = parseAskMarkerText(agentText)
  ask あり → POST pending-question → question.answered / session.inject を待つ
             → 回答テキストを次ターン input に
  ask なし:
    one-shot (run)  → 終了
    interactive (serve) → 次の session.inject を待って次ターン input に
close → unregister
```

- 回答待ちは `question.answered` (question_id 一致) と生テキスト
  `session.inject` の両方を受ける (Discord カードのボタンでも普通の返信でも良い)。
- Concordia 停止時: one-shot は standalone に degrade (リレー無し)、
  interactive は入力経路が無いので fail。

## Discord リレー

イベントは `CodexEventFrameMapper` (移植) で Concordia transcript フレーム
(text / thinking / tool / raw) へ写像し、`OrderedTranscriptSink` で
順序保証 + at-least-once POST。Discord への配信は Concordia egress の既存実装
(`egress-frame-filter` / webhook-pool) に全部委ねる。

Lictor と違い「transcript ファイルの後追い」ではなく「イベントの一次ソース」
なので、二重中継 (2026-07-28 problem log) や誤束縛 (2026-07-30) の類が起きない。

## 承認 (approval)

`approvalPolicy: "never"` + workspace-write sandbox (network は `--network` opt-in)。
app-server からの server-request (`item/*/requestApproval` 等) は安全側既定で
decline する (client 移植のまま)。将来 Question 方式へ昇格する場合は
`serverRequestHandler` を差し替えて pending-question へ流す — フックは既にある。

## Delegation target 化 (Cc 側の残作業)

Cc `provider-preset.ts` に論理 provider `codex-sdk` を追加し、
`spawnSession` (wt.exe) ではなく `satelles run` を detached child で起動する。
prompt / run_id の受け渡しは既存 env 契約のまま:

- `CONCORDIA_DELEGATION_PROMPT_FILE` — レンダリング済み prompt.md
- `CONCORDIA_DELEGATION_RUN_ID` — session metadata に記録され、Cc が run と紐付け

effort は `--effort` (codex `-c model_reasoning_effort=`) へ、model は `--model` へ。

## 非目標 (いまは)

- Claude / Gemini ランナー (将来ここに同居しうるが v0.1 は codex のみ)
- cost/usage の一次取得 (`turn/completed` の usage を frame 化する拡張余地あり。
  現状は Cc の `~/.codex/sessions` 後追い集計に任せる)
- Revisor / Excubitor 登録・PROJECT-CODES 登録 (運用側の後続タスク)

## 不変条件

- Concordia 連携は best-effort。coordinator 停止でユーザに stack trace を見せない。
- `codex app-server` 以外の子プロセスを持たない。ファイル監視をしない。
- pty / ウィンドウ / キーストローク注入を一切持たない。
