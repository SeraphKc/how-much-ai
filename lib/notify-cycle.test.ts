import { test } from "node:test";
import assert from "node:assert/strict";
import { completeNotificationCycle, reconcileNotificationStates } from "./notify-cycle.ts";
import type { AccountEvent, DispatchResult } from "./notify.ts";

const event: AccountEvent = {
  accountLabel: "Work",
  event: {
    type: "warning",
    limitKey: "session",
    limitLabel: "Current session",
    percent: 95,
    peakPct: 95,
    resetsAt: "2026-07-10T10:00:00.000Z",
  },
};

const state = (key: string, value = key) => ({ key, value });

function dispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    channels: ["webhook"],
    telegram: false,
    webhook: true,
    push: { sent: 0, removed: 0, failed: 0 },
    attempted: ["webhook"],
    failures: [],
    delivered: true,
    ...overrides,
  };
}

test("event delivery is verified before event-producing state is persisted", async () => {
  const calls: string[] = [];
  const persisted: Array<{ key: string; value: string }> = [];

  const result = await completeNotificationCycle({
    userId: "default",
    events: [event],
    states: [state("account::session")],
    previousStates: [state("account::session")],
    eventfulStateKeys: new Set(["account::session"]),
    dispatchEvents: async () => {
      calls.push("dispatch");
      return dispatchResult();
    },
    persistStates: async (_userId, states) => {
      calls.push("persist");
      persisted.push(...states);
    },
  });

  assert.deepEqual(calls, ["dispatch", "persist"]);
  assert.deepEqual(persisted, [state("account::session")]);
  assert.equal(result.persisted, 1);
  assert.deepEqual(result.errors, []);
});

test("failed delivery leaves event-producing state unchanged but still persists unrelated state", async () => {
  const persisted: Array<{ key: string; value: string }> = [];
  const result = await completeNotificationCycle({
    userId: "default",
    events: [event],
    states: [state("account::session", "new-session"), state("account::weekly", "new-weekly")],
    previousStates: [state("account::session", "old-session"), state("account::weekly", "old-weekly")],
    eventfulStateKeys: new Set(["account::session"]),
    dispatchEvents: async () =>
      dispatchResult({
        channels: [],
        webhook: false,
        delivered: false,
        failures: [{ channel: "webhook", error: "Webhook rejected the notification (HTTP 503)." }],
      }),
    persistStates: async (_userId, states) => {
      persisted.push(...states);
    },
  });

  assert.deepEqual(persisted, [
    state("account::session", "old-session"),
    state("account::weekly", "new-weekly"),
  ]);
  assert.equal(result.persisted, 2);
  assert.deepEqual(result.errors, [
    { stage: "delivery", error: "webhook: Webhook rejected the notification (HTTP 503)." },
  ]);
});

test("an unexpected dispatcher rejection cannot advance event-producing state", async () => {
  const persisted: Array<{ key: string; value: string }> = [];
  const result = await completeNotificationCycle({
    userId: "default",
    events: [event],
    states: [state("account::session")],
    previousStates: [state("account::session")],
    eventfulStateKeys: new Set(["account::session"]),
    dispatchEvents: async () => {
      throw new Error("transport exploded");
    },
    persistStates: async (_userId, states) => {
      persisted.push(...states);
    },
  });

  assert.deepEqual(persisted, [state("account::session")]);
  assert.equal(result.persisted, 1);
  assert.deepEqual(result.errors, [
    { stage: "delivery", error: "Notification dispatch failed unexpectedly." },
  ]);
});

test("a partial channel failure is surfaced without duplicating alerts already delivered elsewhere", async () => {
  let persistCount = 0;
  const result = await completeNotificationCycle({
    userId: "default",
    events: [event],
    states: [state("account::session")],
    previousStates: [state("account::session")],
    eventfulStateKeys: new Set(["account::session"]),
    dispatchEvents: async () =>
      dispatchResult({
        attempted: ["telegram", "webhook"],
        failures: [{ channel: "telegram", error: "Telegram notification delivery failed." }],
      }),
    persistStates: async (_userId, states) => {
      persistCount += states.length;
    },
  });

  assert.equal(persistCount, 1);
  assert.equal(result.persisted, 1);
  assert.deepEqual(result.errors, [
    { stage: "delivery", error: "telegram: Telegram notification delivery failed." },
  ]);
});

test("state persistence failure after delivery is surfaced and leaves the cycle retryable", async () => {
  const result = await completeNotificationCycle({
    userId: "default",
    events: [event],
    states: [state("account::session")],
    previousStates: [state("account::session")],
    eventfulStateKeys: new Set(["account::session"]),
    dispatchEvents: async () => dispatchResult(),
    persistStates: async () => {
      throw new Error("Convex unavailable");
    },
  });

  assert.equal(result.persisted, 0);
  assert.deepEqual(result.errors, [
    { stage: "state", error: "Couldn't persist notification detector state." },
  ]);
});

test("a no-event detector pass seeds state without invoking the dispatcher", async () => {
  let dispatchCalled = false;
  let persistCount = 0;
  const result = await completeNotificationCycle({
    userId: "default",
    events: [],
    states: [state("account::session")],
    previousStates: [],
    eventfulStateKeys: new Set(),
    dispatchEvents: async () => {
      dispatchCalled = true;
      return dispatchResult();
    },
    persistStates: async (_userId, states) => {
      persistCount += states.length;
    },
  });

  assert.equal(dispatchCalled, false);
  assert.equal(persistCount, 1);
  assert.equal(result.persisted, 1);
});

test("state reconciliation prunes removed accounts and vanished limits", () => {
  type Stored = { key: string; accountId: string; value: string };
  const previous: Stored[] = [
    { key: "kept::session", accountId: "kept", value: "old-session" },
    { key: "kept::vanished", accountId: "kept", value: "old-vanished" },
    { key: "removed::session", accountId: "removed", value: "old-removed" },
  ];
  const next: Stored[] = [{ key: "kept::session", accountId: "kept", value: "new-session" }];

  const snapshot = reconcileNotificationStates(previous, new Set(["kept"]), [
    { accountId: "kept", available: true, states: next },
  ]);

  assert.deepEqual(snapshot, next);
});

test("state reconciliation preserves every row for a temporarily unavailable account", () => {
  const previous = [
    { key: "offline::session", accountId: "offline", value: "session" },
    { key: "offline::weekly", accountId: "offline", value: "weekly" },
  ];

  const snapshot = reconcileNotificationStates(previous, new Set(["offline"]), [
    { accountId: "offline", available: false },
  ]);

  assert.deepEqual(snapshot, previous);
});
