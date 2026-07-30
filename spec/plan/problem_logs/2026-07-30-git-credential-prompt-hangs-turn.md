# git credential prompt hangs a Satelles turn forever

- Date: 2026-07-30
- Status: fixed (this branch)
- Area: Satelles runner / codex 子プロセス env
- Severity: critical — 全ての interactive Satelles セッションが同時に沈黙した

## Summary

2026-07-30 21:00-22:20 JST、稼働中の Satelles interactive セッション 4 本
すべてが Discord からの入力に無応答になった。プロセスは生存し、Concordia
への WS も established、inject も Cc に記録されていたが、ターンが完了しない
ため `InputQueue` に積まれたまま消費されなかった。

根本原因は Codex ターン中に実行された `git push` である。codex sandbox
(workspace-write) 内の git は Windows Credential Manager を読めず、
`git-credential-manager.exe` が対話認証へフォールバックして無期限にブロック
した。TTY もウィンドウも無いため誰も応答できず、exec が返らない → ターンが
終わらない → セッションが沈黙する。

## Evidence

各セッションの最終 transcript frame と、ぶら下がった `git.exe` の起動時刻が
一致した (いずれも直前の assistant 発話が「これから push / PR を作成する」)。

| セッション | 最終 frame (JST) | 停止した git.exe |
| --- | --- | --- |
| satelles-abe33579… | 19:48 頃 / 21:40 | pid 38988 @ 19:48:54 |
| satelles-794da12b… | 20:36:09 | pid 47320 @ 20:36:12 |
| satelles-09855173… | 21:16:07 | pid 39144 @ 21:16:13 |
| satelles-6eda09b1… | 21:29-21:30 | pid 53948 @ 21:29:24 / 61056 @ 21:30:44 |

- 停止した git.exe はいずれも `git-credential-manager.exe` を子に持つ。
- 同 4 プロセスは sandbox の制限トークン下にあり、通常権限からは
  `Stop-Process` / `taskkill /F` ともにアクセス拒否で kill できない
  (`GetOwner` すら rc=2)。**外部からの復旧手段が無い**のが深刻さの本体。
- sandbox 外から `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git ls-remote`
  は即座に成功する。つまり資格情報自体は有効で、sandbox 内から
  Credential Manager を読めないことが分岐点。

## Fix

`src/child-env.ts` を追加し、codex app-server を spawn する env に非対話設定
(`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` / `GIT_ASKPASS=echo` /
`GIT_SSH_COMMAND` の `BatchMode=yes` 等) を重ねる。認証が必要になった場合は
**ハングせず即失敗**し、エラーがターン内でエージェントに返るので、
エージェント側が別手段 (`dw` 等) を選択できる。

## Non-goals / 関連

- ターン停滞の検出とタイムアウトは別ブランチ
  (`fix/satelles-session-timeout`, `src/turn-stall-timer.ts`) が担当する。
  本修正は「そもそも止まらないようにする」側で、両方入れて二重防御にする。
- push 自体を sandbox 内で成功させたい場合は、資格情報を sandbox で読める
  形にする別の設計判断が要る (未決)。

## Verification

- `tests/child-env.test.ts`: 親 env の対話設定を上書きすること、親 env を
  破壊しないこと、ssh 経路も BatchMode になること、親が明示した
  `GIT_SSH_COMMAND` (鍵指定) を捨てずに BatchMode を継ぎ足すことを検証。
- `npm test` / `tsc --noEmit` clean。

## 補足 (レビュー時の判断)

- `StrictHostKeyChecking=accept-new` は入れない。BatchMode=yes だけで
  未知 host key の確認プロンプトは出ず即失敗するので、ハング防止には不要。
  accept-new は初回接続の MITM を素通しするため、対価に見合わない。
- この env が実際に `git` へ届くかは codex の
  `shell_environment_policy.inherit` 次第。sandbox 内で
  `git ls-remote` を 1 回踏んで即失敗することを実機確認しておくこと。
