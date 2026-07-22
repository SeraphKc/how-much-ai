import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffLimit,
  DEFAULT_TOGGLES,
  DEFAULT_THRESHOLDS,
  type LimitReading,
  type NotifyState,
  type NotifyToggles,
} from "./notify-detect.ts";

// Two reset stamps: T2 is strictly later than T1 (a real window rollover).
const T1 = "2026-07-08T10:00:00.000Z";
const T2 = "2026-07-08T15:00:00.000Z";

function reading(over: Partial<LimitReading> = {}): LimitReading {
  return { key: "session", label: "Current session", percent: 50, resetsAt: T1, ...over };
}

const ALL_ON: NotifyToggles = { recovery: true, warning: true, everyReset: true };

test("first observation seeds state and emits nothing", () => {
  const { nextState, events } = diffLimit(undefined, reading({ percent: 42 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.deepEqual(events, []);
  assert.equal(nextState.lastResetsAt, T1);
  assert.equal(nextState.peakPct, 42);
  assert.equal(nextState.warned, false);
});

test("first observation of an already-high limit seeds warned=true (no warning storm)", () => {
  const { nextState, events } = diffLimit(undefined, reading({ percent: 96 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.deepEqual(events, []);
  assert.equal(nextState.warned, true);
});

test("no-op: known limit, low percent, same window → no events", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 55, warned: false };
  const { events, nextState } = diffLimit(prev, reading({ percent: 60 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.deepEqual(events, []);
  assert.equal(nextState.peakPct, 60); // running max
  assert.equal(nextState.warned, false);
});

test("warning: percent crosses warnThreshold once per window", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 80, warned: false };
  const first = diffLimit(prev, reading({ percent: 91 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, "warning");
  assert.equal(first.events[0].percent, 91);
  assert.equal(first.nextState.warned, true);

  // Same window, still high → must NOT warn again.
  const second = diffLimit(first.nextState, reading({ percent: 95 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.deepEqual(second.events, []);
  assert.equal(second.nextState.warned, true);
});

test("warning respects toggle off", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 80, warned: false };
  const toggles: NotifyToggles = { recovery: true, warning: false, everyReset: true };
  const { events } = diffLimit(prev, reading({ percent: 99 }), toggles, DEFAULT_THRESHOLDS);
  assert.deepEqual(events, []);
});

test("every_reset: fires on any window rollover when enabled", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 20, warned: false };
  const toggles: NotifyToggles = { recovery: true, warning: true, everyReset: true };
  const { events, nextState } = diffLimit(prev, reading({ percent: 5, resetsAt: T2 }), toggles, DEFAULT_THRESHOLDS);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("every_reset"));
  // Low prior peak (20) → no recovery.
  assert.ok(!types.includes("recovery"));
  assert.equal(nextState.lastResetsAt, T2);
  assert.equal(nextState.peakPct, 5); // fresh window resets the peak
  assert.equal(nextState.warned, false);
});

test("every_reset stays silent when disabled", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 20, warned: false };
  const toggles: NotifyToggles = { recovery: true, warning: true, everyReset: false };
  const { events } = diffLimit(prev, reading({ percent: 5, resetsAt: T2 }), toggles, DEFAULT_THRESHOLDS);
  assert.deepEqual(events, []);
});

test("recovery: window rolled over after prior peak ≥ recoveryThreshold", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 93, warned: true };
  const { events } = diffLimit(prev, reading({ percent: 8, resetsAt: T2 }), DEFAULT_TOGGLES, DEFAULT_THRESHOLDS);
  const recovery = events.find((e) => e.type === "recovery");
  assert.ok(recovery, "expected a recovery event");
  assert.equal(recovery!.peakPct, 93); // carries the prior peak for the message
  assert.equal(recovery!.percent, 8); // and the fresh (recovered) value
});

test("recovery does NOT fire when the prior peak stayed below recoveryThreshold", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 61, warned: false };
  const { events } = diffLimit(prev, reading({ percent: 4, resetsAt: T2 }), DEFAULT_TOGGLES, DEFAULT_THRESHOLDS);
  assert.ok(!events.some((e) => e.type === "recovery"));
});

test("an earlier-or-equal resets_at is not treated as a rollover", () => {
  const prev: NotifyState = { lastResetsAt: T2, peakPct: 95, warned: true };
  // resets_at moved BACKWARD (clock skew / stale bucket) → not a reset.
  const { events } = diffLimit(prev, reading({ percent: 30, resetsAt: T1 }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.ok(!events.some((e) => e.type === "recovery" || e.type === "every_reset"));
});

test("a backward resets_at blip is not persisted, so the real stamp returning is not a false rollover", () => {
  const prev: NotifyState = { lastResetsAt: T2, peakPct: 95, warned: true };
  // Tick 1: a stale/backward stamp arrives (skew). No event, and we must NOT store the earlier stamp.
  const tick1 = diffLimit(prev, reading({ percent: 40, resetsAt: T1 }), DEFAULT_TOGGLES, DEFAULT_THRESHOLDS);
  assert.deepEqual(tick1.events, []);
  assert.equal(tick1.nextState.lastResetsAt, T2); // stamp did not regress to T1
  // Tick 2: the correct (later) stamp returns — must NOT read as a rollover / false recovery.
  const tick2 = diffLimit(tick1.nextState, reading({ percent: 45, resetsAt: T2 }), DEFAULT_TOGGLES, DEFAULT_THRESHOLDS);
  assert.deepEqual(tick2.events, []);
});

test("recovery does NOT fire when the window rolls over into an already-hot new window", () => {
  const prev: NotifyState = { lastResetsAt: T1, peakPct: 95, warned: true };
  // Rolled over to T2, but the fresh window is already at 92% — not actually 'recovered'.
  const { events } = diffLimit(prev, reading({ percent: 92, resetsAt: T2 }), DEFAULT_TOGGLES, DEFAULT_THRESHOLDS);
  assert.ok(!events.some((e) => e.type === "recovery"));
});

test("a null resets_at reading does not overwrite a known stamp", () => {
  const prev: NotifyState = { lastResetsAt: T2, peakPct: 30, warned: false };
  const { nextState } = diffLimit(prev, reading({ percent: 35, resetsAt: null }), ALL_ON, DEFAULT_THRESHOLDS);
  assert.equal(nextState.lastResetsAt, T2);
});
