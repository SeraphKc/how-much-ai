import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_LIVED_TOKEN_LIFETIME_MS, parseCredentials } from "./credentials.ts";

test("parseCredentials recognizes a dedicated one-year setup token", () => {
  const before = Date.now();
  const parsed = parseCredentials("sk-ant-oat01-monitor_ABC-123");
  const after = Date.now();
  assert.equal(parsed?.credentialKind, "long_lived");
  assert.equal(parsed?.tokens.accessToken, "sk-ant-oat01-monitor_ABC-123");
  assert.equal(parsed?.tokens.refreshToken, null);
  assert.ok((parsed?.tokens.expiresAt ?? 0) >= before + LONG_LIVED_TOKEN_LIFETIME_MS);
  assert.ok((parsed?.tokens.expiresAt ?? 0) <= after + LONG_LIVED_TOKEN_LIFETIME_MS);
});

test("parseCredentials extracts a setup token from copied terminal output", () => {
  assert.equal(
    parseCredentials("Token created successfully:\n  sk-ant-oat01-monitor_ABC-123\nStore it securely")?.tokens.accessToken,
    "sk-ant-oat01-monitor_ABC-123",
  );
});

test("parseCredentials keeps rotating credential JSON metadata", () => {
  assert.deepEqual(
    parseCredentials('{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":123}}')?.tokens,
    { accessToken: "access", refreshToken: "refresh", expiresAt: 123 },
  );
  assert.equal(
    parseCredentials('{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":123}}')
      ?.credentialKind,
    "rotating",
  );
});
