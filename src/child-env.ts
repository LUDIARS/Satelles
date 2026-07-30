/**
 * Codex 子プロセスへ渡す環境変数の組み立て。
 *
 * Satelles はウィンドウも TTY も持たない。子プロセスが対話プロンプトを
 * 出そうとすると、応答する経路が無いまま無期限にブロックし、ターンが
 * 永久に完了しなくなる (= セッションが沈黙する)。
 *
 * 実害の出た経路: codex sandbox 内の `git push` が Windows Credential
 * Manager を読めず、git-credential-manager が対話認証へフォールバックして
 * 停止した。sandbox 内プロセスは外から kill もできないため、セッションは
 * 復旧不能になる。よって「対話を試みる」余地そのものを env で塞ぐ。
 */

/** ssh を非対話にする最小オプション。既存の GIT_SSH_COMMAND へも継ぎ足す。 */
const SSH_BATCH_OPTION = "-o BatchMode=yes";

/** 子プロセスで対話プロンプトを禁止する env の上書き分。 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = Object.freeze({
  /** git 本体の端末プロンプト (Username/Password) を即失敗させる。 */
  GIT_TERMINAL_PROMPT: "0",
  /** GUI/ブラウザ askpass を無効化 (空応答 = 認証失敗として扱われる)。 */
  GIT_ASKPASS: "echo",
  SSH_ASKPASS: "echo",
  /**
   * ssh 経路が使われた場合も鍵プロンプト / host key 確認で止めない。
   * BatchMode=yes は未知 host key でも「確認を求めず失敗」なので、
   * StrictHostKeyChecking の緩和 (accept-new = 初回 MITM を素通し) は入れない。
   */
  GIT_SSH_COMMAND: `ssh ${SSH_BATCH_OPTION}`,
  /** Git Credential Manager: 対話フォールバック (OAuth/デバイスコード) を禁止。 */
  GCM_INTERACTIVE: "never",
  GCM_GUI_PROMPT: "false",
  /** GitHub CLI / npm 等が pager を起動して待つのを防ぐ。 */
  GIT_PAGER: "cat",
  PAGER: "cat",
});

/**
 * 親 env に非対話設定を重ねた env を返す (親 env は破壊しない)。
 * 対話の禁止は不変条件なので親の値より優先する。ただし
 * `GIT_SSH_COMMAND` だけは破棄すると鍵指定 (`ssh -i ...`) や proxy 設定を
 * 落として認証そのものを壊すため、親の指定を残して BatchMode を継ぎ足す。
 */
export function buildCodexChildEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...NON_INTERACTIVE_ENV };
  const inheritedSsh = base.GIT_SSH_COMMAND?.trim();
  if (inheritedSsh) {
    env.GIT_SSH_COMMAND = /BatchMode=/i.test(inheritedSsh)
      ? inheritedSsh
      : `${inheritedSsh} ${SSH_BATCH_OPTION}`;
  }
  return env;
}
