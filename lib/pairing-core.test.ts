import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  generatePairingCode,
  groupCode,
  normalizePairingCode,
  isExpired,
  validatePairing,
} from "./pairing-core.ts";

const NOW = 1_000_000_000_000;

// A deterministic byte source so code generation is assertable.
const bytesFrom = (arr: number[]) => () => Uint8Array.from(arr);
const rampRng = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);

// --- alphabet -----------------------------------------------------------------

test("PAIRING_ALPHABET is 32 unambiguous symbols with no I, O, 0 or 1", () => {
  assert.equal(PAIRING_ALPHABET.length, 32);
  for (const c of ["I", "O", "0", "1"]) assert.ok(!PAIRING_ALPHABET.includes(c), `alphabet must exclude ${c}`);
  // No duplicate symbols.
  assert.equal(new Set(PAIRING_ALPHABET).size, 32);
});

test("PAIRING_CODE_LENGTH is 12 → ~60 bits of entropy", () => {
  assert.equal(PAIRING_CODE_LENGTH, 12);
});

// --- generatePairingCode ------------------------------------------------------

test("generatePairingCode: ramp bytes 0..11 → the canonical ABCD-EFGH-JKLM shape", () => {
  assert.equal(generatePairingCode(rampRng), "ABCD-EFGH-JKLM");
});

test("generatePairingCode: all-zero bytes → all first-symbol, grouped in fours", () => {
  assert.equal(generatePairingCode(() => new Uint8Array(PAIRING_CODE_LENGTH)), "AAAA-AAAA-AAAA");
});

test("generatePairingCode: byte % 32 is used, so 32 wraps to the first symbol (uniform, no modulo bias)", () => {
  // 256 is divisible by 32, so mapping bytes by %32 is perfectly uniform.
  assert.equal(generatePairingCode(bytesFrom(Array(PAIRING_CODE_LENGTH).fill(32))), "AAAA-AAAA-AAAA");
  assert.equal(generatePairingCode(bytesFrom(Array(PAIRING_CODE_LENGTH).fill(255))), "9999-9999-9999");
});

test("generatePairingCode: produces 12 alphabet symbols in three dash-separated groups of four", () => {
  const code = generatePairingCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const bare = code.replace(/-/g, "");
  assert.equal(bare.length, 12);
  for (const c of bare) assert.ok(PAIRING_ALPHABET.includes(c));
});

test("generatePairingCode: two calls with real randomness differ (sanity)", () => {
  assert.notEqual(generatePairingCode(), generatePairingCode());
});

// --- groupCode / normalizePairingCode ----------------------------------------

test("groupCode inserts a dash every four characters", () => {
  assert.equal(groupCode("ABCDEFGHJKLM"), "ABCD-EFGH-JKLM");
  assert.equal(groupCode("ABCDEF"), "ABCD-EF");
});

test("normalizePairingCode uppercases and strips dashes/spaces down to the bare code", () => {
  assert.equal(normalizePairingCode("abcd-efgh-jklm"), "ABCDEFGHJKLM");
  assert.equal(normalizePairingCode("  ABCD EFGH JKLM  "), "ABCDEFGHJKLM");
});

test("normalizePairingCode drops characters outside the alphabet (incl. the excluded I/O/0/1)", () => {
  // O and 1 are not in the alphabet, so they're dropped rather than confused for 0/L.
  assert.equal(normalizePairingCode("AB1O-CD"), "ABCD");
  assert.equal(normalizePairingCode("a!b@c#d"), "ABCD");
});

test("normalizePairingCode of a generated code round-trips to its bare form", () => {
  const code = generatePairingCode(rampRng);
  assert.equal(normalizePairingCode(code), "ABCDEFGHJKLM");
});

// --- TTL / expiry -------------------------------------------------------------

test("PAIRING_TTL_MS is 10 minutes", () => {
  assert.equal(PAIRING_TTL_MS, 10 * 60_000);
});

test("isExpired: false before TTL, true at/after the TTL boundary", () => {
  assert.equal(isExpired(NOW, NOW), false);
  assert.equal(isExpired(NOW, NOW + PAIRING_TTL_MS - 1), false);
  assert.equal(isExpired(NOW, NOW + PAIRING_TTL_MS), true); // boundary counts as expired
  assert.equal(isExpired(NOW, NOW + PAIRING_TTL_MS + 1), true);
});

// --- validatePairing ----------------------------------------------------------

test("validatePairing: missing row → not_found", () => {
  assert.equal(validatePairing(null, NOW), "not_found");
});

test("validatePairing: pending + unexpired → ok", () => {
  assert.equal(validatePairing({ status: "pending", createdAt: NOW }, NOW), "ok");
});

test("validatePairing: pending but past TTL → expired", () => {
  assert.equal(validatePairing({ status: "pending", createdAt: NOW }, NOW + PAIRING_TTL_MS), "expired");
});

test("validatePairing: already done → used (single-use)", () => {
  assert.equal(validatePairing({ status: "done", createdAt: NOW }, NOW), "used");
});

test("validatePairing exposes processing and failed as distinct non-reusable states", () => {
  assert.equal(validatePairing({ status: "processing", createdAt: NOW }, NOW), "processing");
  assert.equal(validatePairing({ status: "failed", createdAt: NOW }, NOW), "failed");
});

test("validatePairing fails closed for an unknown stored state", () => {
  assert.equal(validatePairing({ status: "legacy", createdAt: NOW }, NOW), "failed");
});

test("validatePairing: already marked expired → expired", () => {
  assert.equal(validatePairing({ status: "expired", createdAt: NOW }, NOW), "expired");
});
