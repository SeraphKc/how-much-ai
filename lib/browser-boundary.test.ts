import test from "node:test";
import assert from "node:assert/strict";
import { toBrowserAccount, toBrowserUsageResponse } from "./browser-boundary.ts";
import type { AccountUsageResult } from "./usage-service.ts";
import type { StoredAccount } from "./types.ts";

test("stored-account browser DTOs contain display metadata but never credentials", () => {
  const stored: StoredAccount = {
    id: "account-1",
    email: "person@example.com",
    fullName: "Person One",
    label: "Primary",
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "managed",
    tokens: {
      accessToken: "access-secret-must-not-leak",
      refreshToken: "refresh-secret-must-not-leak",
      expiresAt: 1_800_000_000_000,
    },
  };

  const dto = toBrowserAccount(stored);
  assert.deepEqual(dto, {
    id: stored.id,
    email: stored.email,
    fullName: stored.fullName,
    label: stored.label,
    plan: stored.plan,
    addedAt: stored.addedAt,
    credentialKind: "managed",
    provider: "anthropic",
    credentialExpiresAt: stored.tokens.expiresAt,
  });
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes(stored.tokens.accessToken), false);
  assert.equal(serialized.includes(stored.tokens.refreshToken!), false);
  assert.equal(serialized.includes("accessToken"), false);
  assert.equal(serialized.includes("refreshToken"), false);
  assert.equal(serialized.includes("tokens"), false);
});

test("usage browser responses allowlist status data and strip internal or nested credentials", () => {
  const result: AccountUsageResult = {
    usage: {
      five_hour: { utilization: 42, resets_at: null },
      accidental: { access_token: "nested-access-secret", safe: true },
    },
    profile: {
      account: { uuid: "account-1", email: "person@example.com" },
      accidental: { refreshToken: "nested-refresh-secret", safe: true },
    },
    status: "ready",
    stale: false,
    fetchedAt: 1_700_000_000_000,
    cooldownUntil: 0,
    tokens: {
      accessToken: "rotated-access-secret",
      refreshToken: "rotated-refresh-secret",
      expiresAt: 1_800_000_000_000,
    },
    tokensNeedPersistence: true,
  };

  const response = toBrowserUsageResponse(result);
  assert.equal(response.status, "ready");
  assert.equal(response.usage?.five_hour?.utilization, 42);
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    "rotated-access-secret",
    "rotated-refresh-secret",
    "nested-access-secret",
    "nested-refresh-secret",
    "accessToken",
    "refreshToken",
    "access_token",
    "tokensNeedPersistence",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
