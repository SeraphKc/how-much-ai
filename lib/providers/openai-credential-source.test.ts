import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeJwtPayload,
  chatgptAccountId,
  planTypeFromToken,
  emailFromToken,
  expiryFromAccessToken,
  extractOpenAITokens,
} from "./openai-credential-source.mjs";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

const accessToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "pro" },
  exp: 9_999_999_999,
});
const idToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "prolite" },
  email: "person@example.com",
});

test("decodeJwtPayload returns the payload object", () => {
  assert.equal(decodeJwtPayload(accessToken)?.exp, 9_999_999_999);
  assert.equal(decodeJwtPayload("a.b"), null);
  assert.equal(decodeJwtPayload("notajwt"), null);
});

test("chatgptAccountId reads the embedded account id", () => {
  assert.equal(chatgptAccountId(accessToken), "acc-1");
  assert.equal(chatgptAccountId("garbage"), null);
});

test("planTypeFromToken and emailFromToken read identity claims", () => {
  assert.equal(planTypeFromToken(accessToken), "pro");
  assert.equal(planTypeFromToken(idToken), "prolite");
  assert.equal(emailFromToken(idToken), "person@example.com");
});

test("expiryFromAccessToken uses exp*1000 or falls back to ~10 days out", () => {
  assert.equal(expiryFromAccessToken(accessToken), 9_999_999_999_000);
  const fallback = expiryFromAccessToken("no-exp-here");
  assert.ok(fallback > Date.now() + 9 * 24 * 60 * 60 * 1000);
});

test("extractOpenAITokens parses the full auth.json shape", () => {
  const raw = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: idToken, access_token: accessToken, refresh_token: "rt-1", account_id: "acc-1" },
  });
  assert.deepEqual(extractOpenAITokens(raw), {
    accessToken,
    refreshToken: "rt-1",
    expiresAt: 9_999_999_999_000,
  });
});

test("extractOpenAITokens parses a bare tokens object and defaults refresh to null", () => {
  assert.deepEqual(extractOpenAITokens({ access_token: accessToken }), {
    accessToken,
    refreshToken: null,
    expiresAt: 9_999_999_999_000,
  });
});

test("extractOpenAITokens returns null for junk and empty objects", () => {
  assert.equal(extractOpenAITokens("not json"), null);
  assert.equal(extractOpenAITokens("{}"), null);
  assert.equal(extractOpenAITokens(""), null);
  assert.equal(extractOpenAITokens(null), null);
});
