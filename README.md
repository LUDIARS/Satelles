# Satelles

SDK-style **headless Codex agent runner** for LUDIARS. Short code: **Sa** (仮 — PROJECT-CODES 登録前)。

`Satelles` (Latin: *随伴者 / 護衛*) は、Codex セッションを「Windows Terminal の新ウィンドウ +
cmd + PTY + rollout JSONL tail」で回す従来構成 (Cc spawner + Lictor wrap) を置き換える、
軽量なヘッドレスランナー。`codex app-server` への JSON-RPC 直結で動き、
**ウィンドウ無し・PTY 無し・ファイル監視ゼロ**。

## なぜ

従来の CLI 構成は次のコストを常時払っていた:

- ウィンドウ + ConPTY + TUI 描画 (誰も見ていない)
- rollout JSONL の discover / tail (Defender read 負荷、guardian subagent rollout への
  誤束縛 = Discord リレー停止の実害 2026-07-30)
- resume ベースの束縛 (codex 0.144.x ターン0 rollout 未書き込みバグ)

Satelles は 1 プロセスに thread を生かしたまま `turn/start` を重ねるので、
上記が全部構造的に消える。認証は `codex login` (ChatGPT サブスクリプション) /
API キーのどちらでもそのまま使える (`account/read` 経由で検証)。

## 機能

- **Question 方式 (ask マーカー)**: assistant 出力の ```` ```ask ```` + JSON ブロックを
  検出して Concordia pending-question (Discord カード) へ。回答
  (`question.answered` / `session.inject`) を次ターンの user 入力として続行。
- **Skill 注入**: `--skills-dir` の SKILL.md 群をターン 0 の前置テキストへ。
- **Memory 注入**: `~/.claude/projects/<key>/memory/` から repo 名スコアリングで
  上位 3 件を digest 化して前置 (Lictor と同じヒューリスティック)。
- **Delegation target**: `CONCORDIA_DELEGATION_PROMPT_FILE` /
  `CONCORDIA_DELEGATION_RUN_ID` を Lictor と同じ契約で受ける。Cc 側は
  wt.exe spawn の代わりに `satelles run` をヘッドレス起動するだけでよい。
- **Discord リレー**: 全イベントを Concordia `transcript-frame` へ順序保証 POST
  (Lictor と同じ OrderedTranscriptSink)。egress 側は既存のまま。

## CLI

```sh
satelles run -p task.md [--model gpt-5.6-sol] [--effort xhigh] [--network]
satelles serve [--session-id satelles-xxx]     # 常駐対話 (session.inject 待ち)
```

`satelles --help` で全オプション。Concordia 無し単体実行は
`SATELLES_DISABLE_CONCORDIA=1` (one-shot のみ / リレー無し)。

## ライブラリ

```ts
import { SatellesCodexSession, runSatelles } from "@ludiars/satelles";
```

## 開発

- Node >= 22 / TypeScript strict / 依存は zod のみ。
- `npm test` (node:test + tsx)、`npm run build` (dist 実行 — bin は dist/cli.js を呼ぶ)。
- 設計は `DESIGN.md`。
