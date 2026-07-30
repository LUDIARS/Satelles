import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePreamble,
  composeFirstTurnPrompt,
  loadSkillTexts,
} from "../src/prompt-assemble.js";

test("loadSkillTexts: <dir>/<name>/SKILL.md と <name>.md の両形式を読む", () => {
  const dir = mkdtempSync(join(tmpdir(), "satelles-skills-"));
  try {
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "alpha", "SKILL.md"), "alpha body");
    writeFileSync(join(dir, "beta.md"), "beta body");
    writeFileSync(join(dir, "empty.md"), "   ");
    const skills = loadSkillTexts(dir);
    assert.deepEqual(
      skills.map((s) => [s.name, s.body]),
      [["alpha", "alpha body"], ["beta", "beta body"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkillTexts: 32KiB 超の skill は捨てる", () => {
  const dir = mkdtempSync(join(tmpdir(), "satelles-skills-"));
  try {
    writeFileSync(join(dir, "big.md"), "x".repeat(33 * 1024));
    assert.deepEqual(loadSkillTexts(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkillTexts: null / 不在ディレクトリは空", () => {
  assert.deepEqual(loadSkillTexts(null), []);
  assert.deepEqual(loadSkillTexts(join(tmpdir(), "satelles-missing-dir")), []);
});

test("assemblePreamble: ask + skill + memory を --- 区切りで結合する", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "satelles-memory-"));
  try {
    writeFileSync(join(memoryDir, "project-myrepo-notes.md"), "myrepo memory body");
    const preamble = assemblePreamble({
      cwd: "E:/Document/Ars/myrepo",
      askMarker: true,
      skills: [{ name: "s1", body: "skill body" }],
      memory: true,
      memoryDir,
    });
    assert.ok(preamble.includes("ユーザへの選択提示"));
    assert.ok(preamble.includes("# Skill: s1"));
    assert.ok(preamble.includes("myrepo memory body"));
    const sections = preamble.split("\n\n---\n\n");
    assert.equal(sections.length, 3);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("assemblePreamble: 全部無しなら空文字列", () => {
  const preamble = assemblePreamble({
    cwd: "E:/Document/Ars/nothing-matches-this-repo",
    askMarker: false,
    skills: [],
    memory: false,
  });
  assert.equal(preamble, "");
});

test("composeFirstTurnPrompt: 前置が空ならタスクのみ、あれば --- で連結", () => {
  assert.equal(composeFirstTurnPrompt("", "task"), "task");
  assert.equal(composeFirstTurnPrompt("pre", "task"), "pre\n\n---\n\ntask");
});
