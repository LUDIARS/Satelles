import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TurnStallTimer,
  type TurnStallTimerScheduler,
} from "../src/turn-stall-timer.js";

interface ScheduledTimer {
  callback: () => void;
  timeoutMs: number;
  cleared: boolean;
  unrefed: boolean;
}

function fakeScheduler(timers: ScheduledTimer[]): TurnStallTimerScheduler {
  return {
    set(callback, timeoutMs) {
      const timer = { callback, timeoutMs, cleared: false, unrefed: false };
      timers.push(timer);
      return timer;
    },
    clear(handle) {
      (handle as ScheduledTimer).cleared = true;
    },
    unref(handle) {
      (handle as ScheduledTimer).unrefed = true;
    },
  };
}

test("TurnStallTimer: progress は期限を更新し、停止後は再武装しない", () => {
  const timers: ScheduledTimer[] = [];
  let stalls = 0;
  const timer = new TurnStallTimer(300_000, () => stalls++, fakeScheduler(timers));

  timer.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.timeoutMs, 300_000);
  assert.equal(timers[0]?.unrefed, true);

  timer.progress();
  assert.equal(timers[0]?.cleared, true);
  assert.equal(timers.length, 2);

  timers[1]?.callback();
  assert.equal(stalls, 1);
  timer.progress();
  assert.equal(timers.length, 2);
});

test("TurnStallTimer: null は TaskWorkflow 用の無期限モード", () => {
  const timers: ScheduledTimer[] = [];
  const timer = new TurnStallTimer(null, () => assert.fail("must not stall"), fakeScheduler(timers));

  timer.start();
  timer.progress();
  timer.stop();
  assert.equal(timers.length, 0);
});

test("TurnStallTimer: stop は保有タイマーを解放する", () => {
  const timers: ScheduledTimer[] = [];
  const timer = new TurnStallTimer(1_000, () => undefined, fakeScheduler(timers));

  timer.start();
  timer.stop();
  assert.equal(timers[0]?.cleared, true);
});
