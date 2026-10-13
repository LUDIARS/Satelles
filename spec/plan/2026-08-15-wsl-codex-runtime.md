# WSL 版 codex への spawn 切替 (SATELLES_CODEX_RUNTIME=wsl)

- Date: 2026-08-15
- Status: 実装済み（WSL 実機確認待ち）
- Area: Satelles codex spawn (`src/codex-app-server-client.ts` 他)

## 背景・目的

Windows 版 `codex.exe` は `CreateProcessWithLogonW` → `CodexSandboxOffline`
経由でサンドボックス子プロセスを起動しており、この機構が lsass の
ログオンセッションをリークする (upstream #33356 / #35940、未修正)。
Satelles は `codex app-server` を長時間 (delegation run は無期限) 生かし
続けるため、この経路を使うとホストの lsass セッションが際限なく積み上がる。

WSL2 (Ubuntu) に導入した Linux 版 codex (0.147.0、nvm 管理の Linux node v24)
はこの機構自体を持たず、10-20 回の起動でリークが 0 であることを実測確認済み
(調査ブリーフの前提事実)。よって Satelles から spawn する codex 本体を
Windows 版から WSL 内 Linux 版へ切り替えられるようにする。

**既定は現状維持 (`native`)。** `wsl` は明示 opt-in。

## 実行モード

`SatellesRunConfig.codexRuntime: "native" | "wsl"` (既定 `"native"`)。

環境変数 (`config.ts` で解決、優先順位は既存の model/effort と同じく
CLI 未対応・env のみ — このモードは delegation/運用側が env で選ぶ想定なので
CLI フラグは追加しない):

| env | 既定 | 用途 |
|---|---|---|
| `SATELLES_CODEX_RUNTIME` | `native` | `native` \| `wsl` |
| `SATELLES_WSL_DISTRO` | `Ubuntu` | `wsl.exe -d <distro>` |
| `SATELLES_WSL_USER` | `ubuntu` | `wsl.exe -u <user>` |
| `SATELLES_WSL_CODEX_BINARY` | `codex` | WSL 内 codex 実行コマンド (login shell の PATH 解決に任せるため既定は素の `codex`) |

`SATELLES_CODEX_RUNTIME` に `native`/`wsl` 以外の値が来たら `parseRunConfig`
の他の env 検証と同じ流儀でエラーを積む (runner まで素通しして stack trace
を出さない、CLAUDE.md 不変条件)。

既存の `SATELLES_CODEX_BINARY` (native 用 binary) とは独立に
`SATELLES_WSL_CODEX_BINARY` を持つ — native/wsl で別プロセスなので値の意味
(Windows PATH 上の実行可能ファイル名 vs WSL 内コマンド名) が違う。

## spawn 経路の分岐

`spawnCodexAppServer()` (`src/codex-app-server-client.ts`) に
`runtime` オプションを足し、3 分岐にする:

1. `runtime === "wsl"` → 新関数 `spawnCodexAppServerViaWsl()`
2. `runtime === "native"` かつ `win32` → 既存の `cmd.exe /d /s /c` 経路
3. `runtime === "native"` かつ非 win32 → 既存の直 spawn 経路

`SpawnCodexAppServerOptions` に `runtime?: "native" | "wsl"` (既定
`"native"`) と、wsl 経路にのみ要る `wslDistro` / `wslUser` /
`wslCodexBinary` を追加する。呼び出し元 (`codex-session.ts` →
`runner.ts`) は `config.codexRuntime` 等をそのまま素通しするだけで、
分岐ロジック自体は spawn 関数の中に閉じる (SRP: cwd 変換は
`wsl-path.ts`、argv 組み立ては `codex-app-server-client.ts` 内の
純関数、プロセス起動は `spawn()` 呼び出し 1 箇所)。

### argv 組み立て

```
wsl.exe -d <distro> -u <user> -- bash -lc '<exported env>; cd <wslCwd> && <codexBin> app-server -c k=v --listen stdio://'
```

- `wsl.exe` 自体の起動時作業ディレクトリ (Windows 側 spawn の `cwd`) は
  `options.cwd` (Windows パス) のままでよい — `wsl.exe` プロセス自体は
  Windows 側で立ち上がるので、Node 側 `spawn(..., { cwd })` は素通し。
  WSL 側の作業ディレクトリは bash 内の `cd` で明示的に切り替える方式を採る
  (`wsl.exe` の `--cd` オプションはディストリのデフォルトシェル経由で
  相対解釈が絡み挙動がディストリ依存になりやすいため避け、`bash -lc` 内で
  確実に POSIX パスへ `cd` する)。
- `bash -lc` の引数は 1 本の文字列。中身は `;` 区切りで
  `export K='V'; ...; cd '<wslCwd>' && '<codexBin>' app-server <overrides> --listen stdio://`
  の形に組み立てる。
- login shell (`-l`) を使う理由: `SATELLES_WSL_CODEX_BINARY` 既定 `codex`
  が PATH 解決される前提 (nvm 管理の node/codex は non-login shell の
  `.bashrc` 経路だけでは PATH に乗らないディストリ設定があるため、
  `-l` で `.profile`/`.bash_profile` 系も踏ませて確実性を上げる)。

### シェルエスケープ

`bash -lc` に渡す文字列は shell メタ文字を経由する分、native 経路の
「禁止文字を弾く」よりリスクが高い。よって wsl 経路は **弾く方式ではなく
シングルクォート引用 + 内部の `'` を `'\''` でエスケープする方式**に統一する
(POSIX sh の標準的な安全な引用)。対象:

- `wslCwd` (変換後の POSIX パス)
- `codexBinary` (`SATELLES_WSL_CODEX_BINARY`)
- `configOverrides` の各要素
- 引き継ぐ env の各値

既存の native 経路の「制御文字・`&|<>^` 等を拒否して throw」ガードは
残す (native は変えない)。wsl 経路は「拒否」ではなく「引用でエスケープ」
だが、`\0` / 改行だけは引用では安全にできないため native と同じく拒否する
(コマンド文字列の途中に改行が入ると `bash -lc` の意味が壊れるため)。

### `wsl.exe` 自身のオプション値 (`-d` / `-u`)

`SATELLES_WSL_DISTRO` / `SATELLES_WSL_USER` は `bash -lc` の文字列内では
なく `wsl.exe` の argv に直接載るため、シングルクォート引用は効かない。
ここは引用ではなく **allowlist (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) で拒否する**
方式を採る (`wslOptionValue()`)。制御文字だけを弾くと、`-` 始まりの値が
位置引数ではなく `wsl.exe` の別オプションとして解釈される option smuggling
(`-u --exec ...` 等) を許してしまうため。実在する distro 名 (`Ubuntu-22.04`)
と Linux ユーザ名はこの文字集合に収まる。

## cwd 変換 (`src/wsl-path.ts`)

新規ファイル、副作用なしの純関数のみ:

```ts
export function windowsPathToWslPath(winPath: string): string
```

- `E:\Document\Ars\Satelles` → `/mnt/e/Document/Ars/Satelles`
- ドライブ文字は小文字化 (`/mnt/e/...`、WSL の既定マウント規約)
- バックスラッシュ → スラッシュ
- ドライブレターの無い相対パス・UNC (`\\server\share\...`)・
  すでに POSIX 形式のパスは非対応としてエラー (`Error` を throw)。
  Satelles の `cwd` は常に絶対 Windows パスで来る想定であり、UNC は
  WSL 側の `\\wsl$` 相互運用が絡んで複雑になるためスコープ外。
- 末尾スラッシュの正規化、`..`/`.` の解決はしない (入力は既に絶対パス
  である前提。正規化が要るなら呼び出し側の責務)。

単体テスト: 変換の代表例 (大文字/小文字ドライブ、深い階層、末尾スラッシュ
の有無)、非対応入力 (UNC・相対パス・すでに `/mnt/...` 形式) がエラーに
なることを確認する。

## env 引き継ぎ

WSL はデフォルトで Windows 側の環境変数をすべて子プロセスへ渡さない
(`WSLENV` に列挙した変数だけが `/init` 経由で引き継がれる)。今回必要なのは
`buildCodexChildEnv()` (`src/child-env.ts`) が組み立てる
`NON_INTERACTIVE_ENV` 相当の非対話設定 (`GIT_TERMINAL_PROMPT` 等) のみで、
認証情報や PATH そのものを Windows 側から引き継ぐ必要はない
(認証は WSL 側 `~/.codex/auth.json` 前提、PATH は login shell 解決に任せる)。

`WSLENV` は「Windows → WSL への橋渡しリスト」の性質上、値に space や
特殊文字を含む可能性のある変数 (`GIT_SSH_COMMAND` など) を渡すには不向き
(WSLENV 経由の値はパス変換フラグ以外ほぼ素通しだが、区切り文字 `:` や
値自体のエスケープ規則が bash 側引用より弱い)。よって **`WSLENV` は使わず、
`bash -lc` の文字列内で `export K='V';` を明示的に積む方式に統一する**
(cwd 変換と同じシングルクォート引用ルールを再利用できるため実装が単純)。

対象は `buildCodexChildEnv(process.env)` が返す env のうち
`NON_INTERACTIVE_ENV` のキー集合 (`GIT_TERMINAL_PROMPT` /
`GIT_ASKPASS` / `SSH_ASKPASS` / `GIT_SSH_COMMAND` / `GCM_INTERACTIVE` /
`GCM_GUI_PROMPT` / `GIT_PAGER` / `PAGER`) の値のみ。Windows 側の `PATH` /
`HOME` 等は引き継がない (WSL 側の値をそのまま使う — codex や git の
解決は WSL 側の環境に委ねる)。

## 認証の前提

WSL 版 codex は WSL 側ホームディレクトリの `~/.codex/auth.json` を
そのまま使う (`codex login` を WSL 内で実行済みであること)。Satelles は
これを検証・セットアップしない (`bootstrapCodexSession` の
`account/read` が既存どおり未認証を検出してエラーにする経路がそのまま
効くので、認証切れの検出自体は追加実装不要)。

## `thread/start` / `turn/start` の cwd (JSON-RPC パラメータ)

`bootstrapCodexSession()` (`src/codex-bootstrap.ts`) の `thread/start` と、
各ターンで送る `turn/start` は、ともに cwd を Codex 側で評価する。この値は
Node 側の `spawn()` の `cwd` とは別物 — WSL 内で動く `codex app-server`
プロセスに **その codex 自身が理解できる形式のパス** を渡す必要がある。
WSL 内の codex は当然 POSIX パスしか解釈できないため、`runtime === "wsl"`
のときは両方の cwd と `turn/start` の `writableRoots` を
`windowsPathToWslPath()` で変換する。

呼び出し元は `codex-session.ts` の `SatellesCodexSession.start()`
(`bootstrapCodexSession` を呼ぶ箇所) と `runTurn()` (各 `turn/start`) とする。
`spawnCodexAppServer` 側の cwd 変換 (bash 内 `cd`) と JSON-RPC 側の cwd
変換は責務が違う (プロセスの作業ディレクトリ vs JSON-RPC パラメータ) ため
統合しない。JSON-RPC 側では runtime ごとの cwd を返す小さな純関数を使い、
`thread/start` と `turn/start` の変換漏れを防ぐ。`StartSatellesCodexSessionOptions` に `runtime` /
`wslDistro` / `wslUser` / `wslCodexBinary` を足し、`runtime === "wsl"`
の場合だけ変換後の cwd を `bootstrapCodexSession` に渡す。

## 後方互換

- `codexRuntime` 省略時・`SATELLES_CODEX_RUNTIME` 未設定時は
  `"native"` — 既存コードパス・既存テストは無変更で通る。
- `wsl-path.ts` は新規ファイルで既存コードに影響なし。
- `SpawnCodexAppServerOptions` への `runtime` 等の追加はすべて optional
  (既定 `"native"`) — 既存の呼び出し (`spawnProcess` 注入によるテスト等)
  はそのまま動く。

## native Windows sandbox の一時的な迂回

WSL へ移行できない信頼済みローカル委託に限り、
`SATELLES_CODEX_SANDBOX=danger-full-access` で Windows sandbox launcher を
通らない経路を選べる。既定は `workspace-write` のまま維持し、設定値は
`parseRunConfig()` で列挙検証する。意図しない非 sandbox 実行を防ぐため、
`danger-full-access` は `SATELLES_CODEX_RUNTIME=native` かつ
`CONCORDIA_DELEGATION_RUN_ID` がある場合だけ受理し、それ以外は fail-fast する。

2026-10-14 追記: Discord フォーラムから開く対話セッション (`satelles serve`) も
Satelles へ移すため、`CONCORDIA_SPAWN_ID` (Cc spawn の相関 ID) がある場合も受理する。
付与の可否は Concordia の spawner が決め (委託 run と Cc 管理のフォーラム起動だけ)、
Satelles は Cc 起動の印が無い手動起動を拒む二段目の防御に留める。

選択した値は `thread/start.sandbox` と各 `turn/start.sandboxPolicy` の両方へ
一貫して渡す。後者は `danger-full-access` を `{ type: "dangerFullAccess" }`、
既定を cwd / network 制約付きの `{ type: "workspaceWrite", ... }` に変換する。
偽 app-server を使うプロトコルテストで両境界と既定値を検証する。
実機確認では native Windows の信頼済み委託をこの設定で完走させ、sandbox
launcher 由来の lsass ログオンセッションが増加しないことを観測する。

## テスト方針

- `tests/wsl-path.test.ts`: `windowsPathToWslPath()` の単体テスト
  (代表例の変換、非対応入力のエラー)。
- `tests/codex-app-server-client.test.ts` (新規):
  wsl 経路の argv 組み立てを検証する純関数を
  `codex-app-server-client.ts` から export し (例:
  `buildWslSpawnArgs()`)、実際に `wsl.exe` を起動せず argv の中身
  (distro/user/bash -lc の文字列内容、引用エスケープ、cwd 変換結果、
  env export 有無) をテストする。native 経路の argv 生成にも同様の
  純関数分離があれば揃えるが、既存の `spawnCodexAppServer` は
  `spawnProcess` 注入で `ChildProcessWithoutNullStreams` ごとテスト
  可能な設計なので、wsl 経路もそのパターンを踏襲しつつ argv 自体は
  独立関数に切り出して直接アサートできるようにする。
- `tests/config.test.ts` に `SATELLES_CODEX_RUNTIME` /
  `SATELLES_WSL_DISTRO` / `SATELLES_WSL_USER` /
  `SATELLES_WSL_CODEX_BINARY` の解決・不正値エラーのケースを追加。
- ユーザ明示指示が無い限りテストは実行しない (記述のみ、このセッションでは
  `npm test` を回さない)。

## スコープ外

- Lictor / Concordia 側の配線変更 (`provider-preset.ts` 等)。
- delegation テンプレートの差し替え。
- 実際に `wsl.exe` を起動する E2E 検証。
- WSL 側のセットアップ自動化 (`codex login` を含む)。
