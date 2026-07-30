---
task: usage-cost-frames
project: Satelles
kind: 実装
status: pending
created: 2026-07-30T09:00:00.000Z
source_session: lictor-747d1505-b6bf-4c9e-a545-cdd83526e330
memoria_task_id: 665
actio_task_id: null
memory_links: []
---
# turn/completed の usage を transcript frame 化して Cc コスト集計へ載せる

## 目的

Cc のコスト集計は codex-cli セッションを `~/.codex/sessions/*.jsonl` の後追い走査で
拾うが、codex-sdk (Satelles) セッションは走査対象外 (意図的 — rollout tail 廃止が
存在意義)。app-server の `turn/completed` に載る usage (cached_input 含む) を
一次ソースとして raw frame (`codex_usage`) で POST し、Cc 側 (`cost/log-usage.ts`
系) が codex-sdk provider をその frame から集計できるようにする。

## 完了条件

- Satelles: turn/completed notification から usage を抽出し frame 化 (欠落は無害スキップ)。
- Concordia: provider codex-sdk のセッションを usage frame から集計する経路を追加
  (unpriced 扱いの解消はモデル単価表と突合)。
- プロンプトキャッシュ効果 (cached_input_tokens) が Cc のコスト表示で観測できる。
