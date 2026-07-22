import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notificationBatchId,
  notificationFetchOptions,
  notificationWebPushOptions,
  NOTIFICATION_DELIVERY_TIMEOUT_MS,
} from "./notify-transport.ts";

const events = [
  {
    accountLabel: "Work",
    event: {
      type: "warning",
      limitKey: "session",
      limitLabel: "Current session",
      percent: 95,
      peakPct: 95,
      resetsAt: "2026-07-10T10:00:00.000Z",
    },
  },
];

test("notification batch id is stable for a retry and tenant-scoped", () => {
  assert.equal(notificationBatchId("default", events), notificationBatchId("default", structuredClone(events)));
  const changedReading = structuredClone(events);
  changedReading[0].event.percent = 99;
  changedReading[0].event.peakPct = 99;
  assert.equal(notificationBatchId("default", events), notificationBatchId("default", changedReading));
  assert.notEqual(notificationBatchId("default", events), notificationBatchId("another-tenant", events));
  assert.match(notificationBatchId("default", events), /^notification-[a-f0-9]{64}$/);
});

test("notification transports receive bounded timeout options", () => {
  const fetchOptions = notificationFetchOptions({ method: "POST" });
  assert.equal(fetchOptions.method, "POST");
  assert.ok(fetchOptions.signal instanceof AbortSignal);
  assert.deepEqual(notificationWebPushOptions(), { timeout: NOTIFICATION_DELIVERY_TIMEOUT_MS });
  assert.ok(NOTIFICATION_DELIVERY_TIMEOUT_MS > 0 && NOTIFICATION_DELIVERY_TIMEOUT_MS <= 15_000);
});
