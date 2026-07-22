import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";
import type { ProfileData } from "../types.ts";

const { anthropicProvider, anthropicIdentityFromProfile } = await import("./anthropic.ts");

test("anthropic provider exposes stable descriptor", () => {
  assert.equal(anthropicProvider.id, "anthropic");
  assert.equal(anthropicProvider.label, "Claude");
  assert.equal(anthropicProvider.supportsOAuth, true);
});

test("anthropicIdentityFromProfile maps uuid, email, name, and plan label", () => {
  const profile: ProfileData = {
    account: { uuid: "acc-123", email: "person@example.com", full_name: "A Person", has_claude_max: true },
    organization: { rate_limit_tier: "max_20x" },
  };
  assert.deepEqual(anthropicIdentityFromProfile(profile), {
    id: "acc-123",
    email: "person@example.com",
    fullName: "A Person",
    plan: "Max 20×",
  });
});

test("anthropicIdentityFromProfile throws without a stable identity", () => {
  assert.throws(() => anthropicIdentityFromProfile({ account: { email: "x@y.z" } }), /stable account identity/);
});

test("anthropic parseManualCredential accepts a pasted setup-token", () => {
  const tokens = anthropicProvider.parseManualCredential?.("sk-ant-oat01-abcDEF_ghijklmnop-123");
  assert.ok(tokens);
  assert.equal(tokens?.refreshToken, null);
  assert.match(tokens?.accessToken ?? "", /^sk-ant-oat01-/);
});

test("anthropic parseManualCredential rejects junk", () => {
  assert.equal(anthropicProvider.parseManualCredential?.("not a credential"), null);
});

test("anthropic refresh rejects a credential with no refresh token", () => {
  assert.throws(
    () => anthropicProvider.refresh({ accessToken: "a", refreshToken: null, expiresAt: 0 }),
    /requires a refresh token/,
  );
});
