# Satelles — CLAUDE notes

LUDIARS short code: **Sa** (仮)。usage は `README.md`、設計は `DESIGN.md`。

## When working on this repo

- Stack: Node >= 22 (global `WebSocket` / fetch 前提)、TypeScript strict、
  依存は zod のみ。native dep 禁止 (PTY を持たないのが存在意義)。
- Test runner: 組み込み `node:test` via `tsx`。vitest / jest 禁止。
- Concordia 連携は best-effort。coordinator 停止でユーザに stack trace を
  見せない (one-shot は standalone degrade、interactive のみ fail 可)。
- `codex app-server` 以外の子プロセスを持たない。rollout JSONL を読まない。
  ファイル監視をしない。pty / キーストローク注入を持たない。
  これらは性能特性そのものなので、破る変更は設計から議論する。
- Lictor から移植したファイル (`codex-app-server-client` / `codex-bootstrap` /
  `codex-event-frames` / `transcript-sink` / `ask-json` / `memory-loader`) は
  挙動互換を保つ。Lictor 側で修正が入ったら追随を検討する。

## デプロイの注意 (dist 実行)

- `bin/satelles.mjs` は `dist/cli.js` を実行する。src を直しても
  `npm run build` するまで反映されない。
- main へマージしたら `npm run build` を実行する。

## Cross-repo touchpoints

- `LUDIARS/Concordia` — `/v1/sessions` (register/patch/delete)、
  `/v1/sessions/:id/transcript-frame`、`/v1/sessions/:id/pending-question`、
  `/v1/sessions/:id/event`、`/ws?session=`。委託契約は
  `CONCORDIA_DELEGATION_PROMPT_FILE` / `CONCORDIA_DELEGATION_RUN_ID` (Lictor と同一)。
- `LUDIARS/Lictor` — 移植元。ask マーカープロトコルの正本は Lictor
  `spec/` 側にあり、フォーマット変更は両リポ同時に。
- Cc の delegation target 化は Concordia `provider-preset.ts` に
  `codex-sdk` provider を足す (DESIGN.md 参照、Cc 側 PR で行う)。
