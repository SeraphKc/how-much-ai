import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIRING_CONFIRMATION_ERROR,
  pairingAccountMatches,
  saveThenFinalizePairing,
  type PairingFinalizationPayload,
} from "./pairing-completion.ts";

const classifySaveError = (error: unknown) => ({
  status: 500 as const,
  error: error instanceof Error ? `Safe: ${error.message}` : "Safe failure",
});

test("targeted reconnect accepts only the expected resolved account identity", () => {
  assert.equal(pairingAccountMatches(undefined, "any-account"), true);
  assert.equal(pairingAccountMatches("expected", "expected"), true);
  assert.equal(pairingAccountMatches("expected", "different"), false);
  assert.equal(pairingAccountMatches("expected", undefined), false);
});

test("done is finalized strictly after the vault save resolves", async () => {
  const calls: string[] = [];
  const result = await saveThenFinalizePairing({
    save: async () => {
      calls.push("save:start");
      await Promise.resolve();
      calls.push("save:done");
      return { email: "paid@example.com" };
    },
    emailOf: (value) => value.email,
    finalize: async (payload) => {
      calls.push(`finalize:${payload.status}`);
      return true;
    },
    classifySaveError,
  });

  assert.deepEqual(calls, ["save:start", "save:done", "finalize:done"]);
  assert.deepEqual(result, { ok: true, value: { email: "paid@example.com" } });
});

test("a vault rejection finalizes failed with only the classified public error", async () => {
  const finalized: PairingFinalizationPayload[] = [];
  const result = await saveThenFinalizePairing({
    save: async () => {
      throw new Error("account cap");
    },
    emailOf: () => "unreachable@example.com",
    finalize: async (payload) => {
      finalized.push(payload);
      return true;
    },
    classifySaveError: () => ({ status: 402, error: "Upgrade to connect more." }),
  });

  assert.deepEqual(finalized, [{ status: "failed", error: "Upgrade to connect more." }]);
  assert.deepEqual(result, {
    ok: false,
    saved: false,
    status: 402,
    error: "Upgrade to connect more.",
  });
});

test("a generic save error never attempts to finalize done", async () => {
  const finalized: PairingFinalizationPayload[] = [];
  const result = await saveThenFinalizePairing({
    save: async () => {
      throw new Error("database password must not leak");
    },
    emailOf: () => "unreachable@example.com",
    finalize: async (payload) => {
      finalized.push(payload);
      return true;
    },
    classifySaveError: () => ({ status: 500, error: "Public-safe save failure." }),
  });

  assert.deepEqual(finalized, [{ status: "failed", error: "Public-safe save failure." }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "Public-safe save failure.");
});

test("a finalization failure after save never reports pairing success", async () => {
  const result = await saveThenFinalizePairing({
    save: async () => ({ email: "saved@example.com" }),
    emailOf: (value) => value.email,
    finalize: async () => false,
    classifySaveError,
  });

  assert.deepEqual(result, {
    ok: false,
    saved: true,
    status: 500,
    error: PAIRING_CONFIRMATION_ERROR,
  });
});

test("a thrown finalization error also remains a non-success response", async () => {
  const result = await saveThenFinalizePairing({
    save: async () => ({ email: "saved@example.com" }),
    emailOf: (value) => value.email,
    finalize: async () => {
      throw new Error("Convex unavailable");
    },
    classifySaveError,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.saved, true);
    assert.equal(result.error, PAIRING_CONFIRMATION_ERROR);
  }
});
