import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, loginClientKey, LOGIN_RATE_LIMIT_DEFAULTS } from "./login-rate-limit.ts";

test("login limiter allows the configured failures, then returns an exact Retry-After", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 10_000 });
  assert.deepEqual(limiter.check("203.0.113.8", 1_000), { allowed: true, remaining: 3, retryAfterSeconds: 0 });

  limiter.recordFailure("203.0.113.8", 1_000);
  limiter.recordFailure("203.0.113.8", 1_100);
  assert.equal(limiter.check("203.0.113.8", 1_100).allowed, true);

  limiter.recordFailure("203.0.113.8", 1_200);
  assert.deepEqual(limiter.check("203.0.113.8", 1_200), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 10,
  });
});

test("login limiter resets on success and expires a failed-attempt window", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 5_000 });
  limiter.recordFailure("one", 10_000);
  limiter.reset("one");
  assert.equal(limiter.check("one", 10_001).remaining, 2);

  limiter.recordFailure("two", 10_000);
  limiter.recordFailure("two", 10_100);
  assert.equal(limiter.check("two", 14_999).allowed, false);
  assert.deepEqual(limiter.check("two", 15_000), { allowed: true, remaining: 2, retryAfterSeconds: 0 });
});

test("invalid limiter options retain safe positive defaults", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 0, windowMs: Number.NaN, maxEntries: -5 });
  assert.equal(limiter.check("ip", 0).remaining, LOGIN_RATE_LIMIT_DEFAULTS.maxFailures);
});

test("the limiter bounds key cardinality and uses a fail-closed overflow bucket", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 1, windowMs: 10_000, maxEntries: 1 });
  limiter.recordFailure("first", 0);
  limiter.recordFailure("second", 0);
  assert.equal(limiter.check("first", 1).allowed, false);
  // Further unknown keys share the overflow bucket once the bounded map is full.
  assert.equal(limiter.recordFailure("third", 1).allowed, false);
});

test("loginClientKey accepts only IP-shaped proxy values and fails closed without one", () => {
  assert.equal(loginClientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.4" })), "203.0.113.9");
  assert.equal(loginClientKey(new Headers({ "x-real-ip": "198.51.100.2:443" })), "198.51.100.2");
  assert.equal(loginClientKey(new Headers({ "cf-connecting-ip": "[2001:db8::5]:1234" })), "2001:db8::5");
  assert.equal(loginClientKey(new Headers({ "x-forwarded-for": "attacker-controlled" })), "unknown");
  assert.equal(loginClientKey(new Headers()), "unknown");
});

test("direct self-hosting can ignore spoofable proxy headers and share the fail-closed bucket", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.42", "x-real-ip": "198.51.100.9" });
  assert.equal(loginClientKey(headers, false), "unknown");
});
