// Pure logic for the optional Convex-backed device-pairing flow.
//
// This module has NO I/O — no Convex, no fetch, no node APIs beyond an injectable RNG — so it is
// unit-testable in isolation (see pairing-core.test.ts) and safe to import from a route. The Convex
// mutation in convex/pairings.ts mirrors `validatePairing`/the TTL by hand (Convex modules and the
// Next app don't share a module graph), so the tested rule and the transactional claim agree.
//
// Why a code at all: a website can't read a visitor's machine, so the browser shows a short code and
// the visitor runs a one-line helper that reads their local Claude token and POSTs it back paired to
// this code. Security rests on three things the code carries:
//   1. Large keyspace — 12 symbols × 5 bits = ~60 bits (32^12 ≈ 1.15e18). Guessing the public
//      "complete" endpoint is infeasible even at thousands of tries/sec within the short TTL.
//   2. Short TTL — 10 minutes, after which the code is rejected (isExpired / validatePairing).
//   3. Single use — Convex claims pending→processing atomically and only finalizes after the vault
//      write, so a code works exactly once without publishing premature success.

export const PAIRING_TTL_MS = 10 * 60_000; // 10 min — codes expire fast to shrink the guessing window.
export const PAIRING_CODE_LENGTH = 12; // 12 symbols × 5 bits ≈ 60 bits of entropy.
export const PAIRING_GROUP = 4; // display grouping: ABCD-EFGH-JKLM.

// Crockford-flavored base32 minus the visually ambiguous glyphs I, O, 0 and 1. Exactly 32 symbols,
// so mapping a random byte with `% 32` is perfectly uniform (256 is divisible by 32 → no modulo bias).
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PairingStatus = "pending" | "processing" | "done" | "failed" | "expired";
export type PairingValidation = "ok" | "processing" | "failed" | "expired" | "used" | "not_found";

// Cryptographically-strong bytes. Injectable so tests are deterministic; the default uses Web Crypto,
// which is a global in both the Node route runtime and the browser.
function defaultRng(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// Insert a dash every PAIRING_GROUP characters: "ABCDEFGHJKLM" → "ABCD-EFGH-JKLM".
export function groupCode(bare: string, group = PAIRING_GROUP): string {
  const parts = bare.match(new RegExp(`.{1,${group}}`, "g"));
  return parts ? parts.join("-") : bare;
}

// A fresh, grouped pairing code for display. Stored (and looked up) in its bare, normalized form.
export function generatePairingCode(rng: (n: number) => Uint8Array = defaultRng, length = PAIRING_CODE_LENGTH): string {
  const bytes = rng(length);
  let bare = "";
  for (let i = 0; i < length; i++) bare += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  return groupCode(bare);
}

// Canonicalize user/CLI-supplied input: uppercase, then keep only real alphabet symbols. This drops
// dashes, spaces, and any character outside the alphabet (including a mistyped O/1 that isn't in it),
// yielding the bare 12-char form used as the storage key.
export function normalizePairingCode(input: string): string {
  const upper = (input ?? "").toUpperCase();
  let out = "";
  for (const c of upper) if (PAIRING_ALPHABET.includes(c)) out += c;
  return out;
}

// A code is expired once at least TTL has elapsed since it was created (boundary counts as expired).
export function isExpired(createdAt: number, now: number, ttlMs = PAIRING_TTL_MS): boolean {
  return now - createdAt >= ttlMs;
}

// The verdict for a lookup, used by the status endpoint and mirrored by the Convex claim. A pairing is
// usable only while pending AND unexpired; "done" is single-use exhaustion, "expired" is the timeout.
export function validatePairing(
  pairing: { status: string; createdAt: number } | null,
  now: number,
  ttlMs = PAIRING_TTL_MS,
): PairingValidation {
  if (!pairing) return "not_found";
  if (pairing.status === "processing") return "processing";
  if (pairing.status === "done") return "used";
  if (pairing.status === "failed") return "failed";
  if (pairing.status === "expired") return "expired";
  if (isExpired(pairing.createdAt, now, ttlMs)) return "expired";
  return pairing.status === "pending" ? "ok" : "failed";
}
