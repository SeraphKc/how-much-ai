import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePairingClaim,
  pairingRecordReclaimable,
  PAIRING_PROCESSING_TIMEOUT_MS,
  PAIRING_TTL_MS,
} from "../convex/pairingState.ts";

const NOW = 1_000_000;

test("a missing pairing is rejected as not found", () => {
  assert.deepEqual(decidePairingClaim(null, NOW), {
    ok: false,
    reason: "not_found",
    transition: null,
  });
});

test("only an unexpired pending pairing can be claimed", () => {
  assert.deepEqual(decidePairingClaim({ status: "pending", createdAt: NOW }, NOW), { ok: true });
  assert.deepEqual(
    decidePairingClaim({ status: "pending", createdAt: NOW }, NOW + PAIRING_TTL_MS - 1),
    { ok: true },
  );
});

test("a pending pairing expires at the TTL boundary and asks the mutation to persist expiry", () => {
  assert.deepEqual(decidePairingClaim({ status: "pending", createdAt: NOW }, NOW + PAIRING_TTL_MS), {
    ok: false,
    reason: "expired",
    transition: "expired",
  });
});

test("processing rejects a concurrent completion before it can save the vault", () => {
  assert.deepEqual(decidePairingClaim({ status: "processing", createdAt: NOW }, NOW), {
    ok: false,
    reason: "processing",
    transition: null,
  });
});

test("a stale processing claim becomes terminal failed and is never made reusable", () => {
  const row = { status: "processing", createdAt: NOW, processingAt: NOW + 10 };
  assert.deepEqual(
    decidePairingClaim(row, NOW + 10 + PAIRING_PROCESSING_TIMEOUT_MS - 1),
    { ok: false, reason: "processing", transition: null },
  );
  assert.deepEqual(
    decidePairingClaim(row, NOW + 10 + PAIRING_PROCESSING_TIMEOUT_MS),
    { ok: false, reason: "failed", transition: "failed" },
  );
});

test("legacy processing rows without processingAt use createdAt for stale recovery", () => {
  assert.deepEqual(
    decidePairingClaim(
      { status: "processing", createdAt: NOW },
      NOW + PAIRING_PROCESSING_TIMEOUT_MS,
    ),
    { ok: false, reason: "failed", transition: "failed" },
  );
});

test("all terminal states are single-use and cannot be reclaimed", () => {
  for (const status of ["done", "failed", "expired"] as const) {
    const decision = decidePairingClaim({ status, createdAt: NOW }, NOW);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.reason, status);
      assert.equal(decision.transition, null);
    }
  }
});

test("an unknown persisted state fails closed rather than becoming reusable", () => {
  assert.deepEqual(decidePairingClaim({ status: "legacy-state", createdAt: NOW }, NOW), {
    ok: false,
    reason: "failed",
    transition: null,
  });
});

test("pairing retention preserves live rows and reclaims only stale or terminal records", () => {
  assert.equal(pairingRecordReclaimable({ status: "pending", createdAt: NOW }, NOW), false);
  assert.equal(
    pairingRecordReclaimable({ status: "pending", createdAt: NOW }, NOW + PAIRING_TTL_MS),
    true,
  );
  assert.equal(
    pairingRecordReclaimable(
      { status: "processing", createdAt: NOW, processingAt: NOW + 1 },
      NOW + PAIRING_PROCESSING_TIMEOUT_MS,
    ),
    false,
  );
  assert.equal(
    pairingRecordReclaimable(
      { status: "processing", createdAt: NOW, processingAt: NOW + 1 },
      NOW + 1 + PAIRING_PROCESSING_TIMEOUT_MS,
    ),
    true,
  );
  for (const status of ["done", "failed", "expired", "unknown"]) {
    assert.equal(pairingRecordReclaimable({ status, createdAt: NOW }, NOW), true);
  }
});
