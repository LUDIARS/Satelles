import assert from "node:assert/strict";
import test from "node:test";

import { buildWslSpawnArgs } from "../src/codex-app-server-client.js";

const BASE_OPTIONS = {
  binary: "codex",
  cwd: "E:\\Document\\Ars\\Satelles",
  env: {} as NodeJS.ProcessEnv,
};

test("WSL receives the current sidecar identity without forwarding arbitrary parent env", () => {
  const script = buildWslSpawnArgs({ ...BASE_OPTIONS, env: {
    LICTOR_PORT: "54321", LICTOR_SESSION_ID: "satelles-child", PARENT_SECRET: "not-for-wsl",
  } })[7];
  assert.match(script, /export LICTOR_PORT='54321'/);
  assert.match(script, /export LICTOR_SESSION_ID='satelles-child'/);
  assert.doesNotMatch(script, /PARENT_SECRET|not-for-wsl/);
});

test("buildWslSpawnArgs: distro/user 既定値と cwd 変換", () => {
  const args = buildWslSpawnArgs(BASE_OPTIONS);
  assert.deepEqual(args.slice(0, 4), ["-d", "Ubuntu", "-u", "ubuntu"]);
  assert.equal(args[4], "--");
  assert.equal(args[5], "bash");
  assert.equal(args[6], "-lc");
  const script = args[7];
  assert.ok(script, "script が生成される");
  assert.match(script, /cd '\/mnt\/e\/Document\/Ars\/Satelles' &&/);
  assert.match(script, /'codex' 'app-server' '--listen' 'stdio:\/\/'/);
});

test("buildWslSpawnArgs: distro/user/codexBinary の明示指定を反映する", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    wslDistro: "Debian",
    wslUser: "coder",
    wslCodexBinary: "/home/coder/.local/bin/codex",
  });
  assert.deepEqual(args.slice(0, 4), ["-d", "Debian", "-u", "coder"]);
  const script = args[7];
  assert.match(script, /'\/home\/coder\/\.local\/bin\/codex' 'app-server'/);
});

test("buildWslSpawnArgs: WSL バイナリ未指定時は native binary ではなく codex を使う", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    binary: "C:\\tools\\codex.exe",
  });
  const script = args[7];
  assert.match(script, /'codex' 'app-server'/);
  assert.doesNotMatch(script, /codex\.exe/);
});

test("buildWslSpawnArgs: configOverrides を -c フラグとして渡す", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    configOverrides: ["model=gpt-5.6-sol", "model_reasoning_effort=xhigh"],
  });
  const script = args[7];
  assert.match(script, /'-c' 'model=gpt-5\.6-sol' '-c' 'model_reasoning_effort=xhigh'/);
});

test("buildWslSpawnArgs: NON_INTERACTIVE_ENV のキーだけを export する", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
      PATH: "C:\\should-not-leak",
      HOME: "C:\\Users\\example-user",
    } as NodeJS.ProcessEnv,
  });
  const script = args[7];
  assert.match(script, /export GIT_TERMINAL_PROMPT='0';/);
  assert.match(script, /export GIT_ASKPASS='echo';/);
  assert.doesNotMatch(script, /PATH/);
  assert.doesNotMatch(script, /HOME/);
});

test("buildWslSpawnArgs: env 値のシングルクォートを安全にエスケープする", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    env: {
      GIT_SSH_COMMAND: "it's a test",
    } as NodeJS.ProcessEnv,
  });
  const script = args[7];
  // POSIX の標準的な単一引用エスケープ: `'` を `'\''` (引用終了 + エスケープ済み
  // クォート + 引用再開) に置換する。よって `it's` は `'it'\''s'` になる。
  assert.match(script, /export GIT_SSH_COMMAND='it'\\''s a test';/);
});

test("buildWslSpawnArgs: env 値に制御文字が含まれるとエラー", () => {
  assert.throws(
    () =>
      buildWslSpawnArgs({
        ...BASE_OPTIONS,
        env: { GIT_TERMINAL_PROMPT: "0\ninjected" } as NodeJS.ProcessEnv,
      }),
    /unsafe control character/,
  );
});

test("buildWslSpawnArgs: cwd が絶対 Windows パスでないとエラー", () => {
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, cwd: "relative/path" }),
    /unsupported path for WSL conversion/,
  );
});

test("buildWslSpawnArgs: wsl.exe を起動せず argv だけを組み立てる (純関数)", () => {
  // このテストは spawn を一切呼ばないことそのものが仕様: buildWslSpawnArgs は
  // 文字列配列を返すだけの純関数であるべき。
  const args = buildWslSpawnArgs(BASE_OPTIONS);
  assert.ok(Array.isArray(args));
  assert.ok(args.every((a) => typeof a === "string"));
});

test("buildWslSpawnArgs: wslDistro に制御文字が含まれるとエラー", () => {
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslDistro: "Ubuntu\ninjected" }),
    /unsafe control character in WSL distro/,
  );
});

test("buildWslSpawnArgs: wslUser に制御文字が含まれるとエラー", () => {
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslUser: "ubuntu\rinjected" }),
    /unsafe control character in WSL user/,
  );
});

test("buildWslSpawnArgs: `-` 始まりの distro/user は wsl.exe のオプションとして解釈されうるので拒否", () => {
  // `-u --exec ...` のように、位置引数のつもりの値が wsl.exe 側で別オプション
  // として解釈される option smuggling を防ぐ。
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslDistro: "--exec" }),
    /unsafe value for WSL distro/,
  );
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslUser: "--system" }),
    /unsafe value for WSL user/,
  );
});

test("buildWslSpawnArgs: 空白やシェルメタ文字を含む distro/user を拒否", () => {
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslDistro: "Ubuntu 22.04" }),
    /unsafe value for WSL distro/,
  );
  assert.throws(
    () => buildWslSpawnArgs({ ...BASE_OPTIONS, wslUser: "ubuntu&whoami" }),
    /unsafe value for WSL user/,
  );
});

test("buildWslSpawnArgs: 実在しうる distro/user 名は通す", () => {
  const args = buildWslSpawnArgs({
    ...BASE_OPTIONS,
    wslDistro: "Ubuntu-22.04",
    wslUser: "dev_user-1",
  });
  assert.deepEqual(args.slice(0, 4), ["-d", "Ubuntu-22.04", "-u", "dev_user-1"]);
});
