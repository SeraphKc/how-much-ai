import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { authOpen, createSession, safeEqual, verifySession } from "./session.ts";

const originalPassword = process.env.APP_PASSWORD;
const originalAuthSecret = process.env.AUTH_SECRET;
const originalLegacyMode = process.env.AUTH_MODE;

function restore(name: "APP_PASSWORD" | "AUTH_SECRET" | "AUTH_MODE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("APP_PASSWORD", originalPassword);
  restore("AUTH_SECRET", originalAuthSecret);
  restore("AUTH_MODE", originalLegacyMode);
});

test("zero configuration is open, while APP_PASSWORD enables the gate", () => {
  delete process.env.AUTH_MODE;
  delete process.env.APP_PASSWORD;
  assert.equal(authOpen(), true);

  process.env.APP_PASSWORD = "a strong local password";
  assert.equal(authOpen(), false);
});

test("an unsupported legacy auth mode fails closed after an edition change", () => {
  delete process.env.APP_PASSWORD;
  process.env.AUTH_MODE = "clerk";
  assert.equal(authOpen(), false);
});

test("password sessions verify before expiry and reject tampering", async () => {
  process.env.APP_PASSWORD = "correct horse battery staple";
  process.env.AUTH_SECRET = "independent session secret";
  const issuedAt = 1_700_000_000_000;
  const token = await createSession(issuedAt);

  assert.equal(await verifySession(token, issuedAt + 1_000), true);
  assert.equal(await verifySession(`${token}x`, issuedAt + 1_000), false);
  assert.equal(await verifySession(token, issuedAt + 31 * 24 * 60 * 60 * 1_000), false);
});

test("password comparison handles equal, unequal, and unequal-length values", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "diff"), false);
  assert.equal(safeEqual("short", "a much longer value"), false);
});
