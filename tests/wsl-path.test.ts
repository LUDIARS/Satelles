import assert from "node:assert/strict";
import test from "node:test";

import { codexRuntimeCwd, windowsPathToWslPath, WslPathError } from "../src/wsl-path.js";

test("windowsPathToWslPath: 基本の変換 (ドライブ小文字化 + スラッシュ化)", () => {
  assert.equal(
    windowsPathToWslPath("E:\\Document\\Ars\\Satelles"),
    "/mnt/e/Document/Ars/Satelles",
  );
});

test("windowsPathToWslPath: 大文字/小文字どちらのドライブ文字も小文字化する", () => {
  assert.equal(windowsPathToWslPath("C:\\Users\\example-user"), "/mnt/c/Users/example-user");
  assert.equal(windowsPathToWslPath("c:\\Users\\example-user"), "/mnt/c/Users/example-user");
});

test("windowsPathToWslPath: 深い階層とスペースを含むパス", () => {
  assert.equal(
    windowsPathToWslPath("E:\\Document\\Ars\\Some Dir\\Sub Dir\\file"),
    "/mnt/e/Document/Ars/Some Dir/Sub Dir/file",
  );
});

test("windowsPathToWslPath: 末尾スラッシュの有無を吸収する", () => {
  assert.equal(windowsPathToWslPath("E:\\Document\\Ars\\"), "/mnt/e/Document/Ars");
  assert.equal(windowsPathToWslPath("E:\\Document\\Ars"), "/mnt/e/Document/Ars");
});

test("windowsPathToWslPath: 連続する区切り文字を1つに畳む", () => {
  assert.equal(windowsPathToWslPath("E:\\\\Document\\\\Ars"), "/mnt/e/Document/Ars");
});

test("windowsPathToWslPath: ドライブ直下 (ルート) も変換できる", () => {
  assert.equal(windowsPathToWslPath("E:\\"), "/mnt/e");
  assert.equal(windowsPathToWslPath("E:/"), "/mnt/e");
});

test("windowsPathToWslPath: フォワードスラッシュ形式の Windows パスも受ける", () => {
  assert.equal(windowsPathToWslPath("E:/Document/Ars/Satelles"), "/mnt/e/Document/Ars/Satelles");
});

test("windowsPathToWslPath: UNC パスは非対応でエラー", () => {
  assert.throws(
    () => windowsPathToWslPath("\\\\server\\share\\dir"),
    WslPathError,
  );
});

test("windowsPathToWslPath: 相対パスは非対応でエラー", () => {
  assert.throws(() => windowsPathToWslPath("Document\\Ars"), WslPathError);
  assert.throws(() => windowsPathToWslPath(".\\Document"), WslPathError);
});

test("windowsPathToWslPath: 既に POSIX 形式のパスは非対応でエラー", () => {
  assert.throws(() => windowsPathToWslPath("/mnt/e/Document/Ars"), WslPathError);
  assert.throws(() => windowsPathToWslPath("/home/ubuntu"), WslPathError);
});

test("windowsPathToWslPath: 空文字はエラー", () => {
  assert.throws(() => windowsPathToWslPath(""), WslPathError);
});

test("codexRuntimeCwd: WSL の JSON-RPC cwd は POSIX 形式、native は入力を保つ", () => {
  const cwd = "E:\\Document\\Ars\\Satelles";
  assert.equal(codexRuntimeCwd("wsl", cwd), "/mnt/e/Document/Ars/Satelles");
  assert.equal(codexRuntimeCwd("native", cwd), cwd);
  assert.equal(codexRuntimeCwd(undefined, cwd), cwd);
});
