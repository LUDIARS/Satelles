import { test } from "node:test";
import assert from "node:assert/strict";
import { isHumanInject } from "../src/inject-origin.js";

test("人間の発言 (platform source / source なし) は回答になれる", () => {
  assert.equal(isHumanInject("discord:123456789:c:m"), true);
  assert.equal(isHumanInject("slack:U123:C1:1700"), true);
  // CLI からの直 inject は source を持たない。
  assert.equal(isHumanInject(null), true);
  assert.equal(isHumanInject(undefined), true);
  assert.equal(isHumanInject("  "), true);
});

test("Concordia の自動注入は回答にならない", () => {
  // 2026-07-30 の実害はこれ (作業ポリシーの session-start 注入)。
  assert.equal(isHumanInject("session-start:cc-workflow"), false);
  assert.equal(isHumanInject("auto:stall-nudge"), false);
  assert.equal(isHumanInject("delegation:run-1"), false);
  assert.equal(isHumanInject("taskflow:continue"), false);
  assert.equal(isHumanInject("admin-stop-session"), false);
  assert.equal(isHumanInject("initial-work"), false);
  assert.equal(isHumanInject("discord-enter-fallback"), false);
});

test("platform を名乗る skill 注入も人間ではない", () => {
  assert.equal(isHumanInject("cc-skill"), false);
  assert.equal(isHumanInject("discord:cc-skill"), false);
  assert.equal(isHumanInject("slack:cc-skill"), false);
  // 詳細を後ろに足した形も同じ (人間の discord source と桁数が揃うため)。
  assert.equal(isHumanInject("discord:cc-skill:C1:1700"), false);
  assert.equal(isHumanInject("cc-skill:review"), false);
});

test("未知の source は人間側に倒す (回答を取りこぼさない)", () => {
  assert.equal(isHumanInject("something-new"), true);
  assert.equal(isHumanInject("teams:42:c:m"), true);
});
