import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canMutateNotificationLease,
  claimNotificationLease,
  NOTIFICATION_LEASE_MS,
} from "./notification-lease-core.ts";

test("an active tenant notification lease rejects an overlapping runner", () => {
  const current = { owner: "first", leaseUntil: 50_000 };
  assert.deepEqual(claimNotificationLease(current, "second", 49_999), {
    acquired: false,
    owner: "first",
    leaseUntil: 50_000,
  });
});

test("an expired notification lease can be reclaimed", () => {
  assert.deepEqual(claimNotificationLease({ owner: "dead", leaseUntil: 50_000 }, "next", 50_000), {
    acquired: true,
    owner: "next",
    leaseUntil: 50_000 + NOTIFICATION_LEASE_MS,
  });
});

test("only the current owner may renew or release a tenant lease", () => {
  const current = { owner: "winner", leaseUntil: 50_000 };
  assert.equal(canMutateNotificationLease(current, "winner"), true);
  assert.equal(canMutateNotificationLease(current, "stale-runner"), false);
  assert.equal(canMutateNotificationLease(null, "winner"), false);
});
