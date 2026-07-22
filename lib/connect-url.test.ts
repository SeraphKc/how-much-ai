import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HMC_URL,
  HmcUrlError,
  buildPairingCommand,
  isLoopbackHostname,
  parseHmcUrl,
  serverErrorText,
  shellSingleQuote,
} from "./connect-url.mjs";

test("target parser defaults to the local app and normalizes valid HTTPS origins", () => {
  assert.equal(DEFAULT_HMC_URL, "http://localhost:3000");
  assert.equal(parseHmcUrl(undefined), DEFAULT_HMC_URL);
  assert.equal(parseHmcUrl("   "), DEFAULT_HMC_URL);
  assert.equal(parseHmcUrl(" https://Example.COM:443/ "), "https://example.com");
  assert.equal(parseHmcUrl("https://example.com:8443"), "https://example.com:8443");
});

test("CLI target parser permits HTTP only for loopback development origins", () => {
  for (const value of [
    "http://localhost:3000",
    "http://app.localhost:3000/",
    "http://127.0.0.1:3000",
    "http://127.42.0.8",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]:3000",
  ]) {
    assert.doesNotThrow(() => parseHmcUrl(value), value);
  }
  assert.equal(isLoopbackHostname("localhost.example.com"), false);
});

test("CLI target parser rejects insecure non-loopback destinations", () => {
  for (const value of [
    "http://example.com",
    "http://localhost.example.com",
    "http://192.168.1.2:3000",
    "http://0.0.0.0:3000",
    "ftp://example.com",
  ]) {
    assert.throws(() => parseHmcUrl(value), HmcUrlError, value);
  }
});

test("CLI target parser rejects credentials and non-origin URL components", () => {
  for (const value of [
    "https://user:pass@example.com",
    "https://example.com/base",
    "https://example.com/?target=other",
    "https://example.com/#fragment",
    "not a URL",
  ]) {
    assert.throws(() => parseHmcUrl(value), HmcUrlError, value);
  }
});

test("CLI target parser rejects shell metacharacters accepted by WHATWG URL", () => {
  for (const value of [
    "https://x'$(id)'",
    "https://x%27%24%28id%29%27",
    "https://x;id",
    "https://x$(id)",
  ]) {
    assert.throws(() => parseHmcUrl(value), HmcUrlError, value);
  }
});

test("pairing command normalizes, quotes, and validates every interpolated value", () => {
  assert.equal(
    buildPairingCommand("ABCD-EFGH-JKLM", " https://Example.COM:443/ "),
    "HOW_MUCH_AI_URL='https://example.com' npx github:SeraphKc/how-much-ai#v0.1.0 connect ABCD-EFGH-JKLM",
  );
  assert.equal(shellSingleQuote("value'$(id)"), "'value'\"'\"'$(id)'");
  assert.throws(() => buildPairingCommand("ABCD-EFGH-$(id)", "https://example.com"), HmcUrlError);
  assert.throws(() => buildPairingCommand("ABCD-EFGH-JKLM", "https://x'$(id)'"), HmcUrlError);
});

test("connection errors surface only safe opaque server references", () => {
  assert.equal(
    serverErrorText("The encrypted credential could not be saved.", "Pairing failed.", "err_0123456789ab"),
    "The encrypted credential could not be saved. Reference: err_0123456789ab.",
  );
  assert.equal(
    serverErrorText("Pairing failed", "Fallback", "err_0123456789ab\nleak"),
    "Pairing failed",
  );
});
