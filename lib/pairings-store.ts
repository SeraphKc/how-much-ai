// App-side access to the Convex `pairings` table (Feature B). Mirrors lib/vault.ts's Convex wiring:
// the shared VAULT_ACCESS_SECRET proves the app to the secret-gated Convex functions.
//
// Pairing REQUIRES Convex: the public "complete" endpoint (hit by the CLI helper, no session) and the
// browser's "start"/"status" endpoints must all reach the same shared store. When Convex isn't
// configured (a self-host with the file/redis backend), pairing is unavailable and the UI falls back
// to the manual paste flow — so this module reports availability rather than throwing.

import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { loginClientKey, trustedLoginProxyHeaders } from "./login-rate-limit";
import type { PairingStatus } from "./pairing-core";

function convexConfig(): { url: string; secret: string } | null {
  const url = (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || "").trim();
  const secret = (process.env.VAULT_ACCESS_SECRET || "").trim();
  if (Boolean(url) !== Boolean(secret)) {
    throw new Error("Pairing storage is partially configured; set both CONVEX_URL and VAULT_ACCESS_SECRET");
  }
  return url && secret ? { url, secret } : null;
}

export function pairingBackendAvailable(): boolean {
  return convexConfig() !== null;
}

export interface PairingRow {
  userId: string;
  status: PairingStatus;
  email: string | null;
  error: string | null;
  createdAt: number;
  processingAt: number | null;
}

export type ClaimResult =
  | { ok: true; userId: string; expectedAccountId?: string }
  | { ok: false; reason: "not_found" | "processing" | "done" | "failed" | "expired" };

export type PairingPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_found"
        | "processing"
        | "done"
        | "failed"
        | "expired"
        | "rate_limited"
        | "attempts_exhausted";
      retryAfterSeconds?: number;
    };

export type PairingFinalization =
  | { status: "done"; email: string }
  | { status: "failed"; error: string };

// Convex keeps one fixed-window counter per HMAC bucket rather than one row per attacker-supplied
// address. This bounds rate-limit storage while still distributing ordinary clients across a large
// keyspace. Raw addresses never leave the app server.
export const PAIRING_RATE_BUCKET_COUNT = 16_384;

export function pairingRateBucket(headers: Pick<Headers, "get">): string {
  const cx = convexConfig();
  if (!cx) throw new Error("Pairing needs Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  // Direct self-hosting must not let a caller mint arbitrary buckets with spoofed forwarding
  // headers. Known platforms (or an explicit trusted-proxy opt-in) overwrite those headers and may
  // safely use the real client address; every other deployment shares the fail-closed unknown bucket.
  const clientKey = loginClientKey(headers, trustedLoginProxyHeaders());
  const digest = crypto.createHmac("sha256", cx.secret).update(clientKey).digest();
  return `b${digest.readUInt32BE(0) % PAIRING_RATE_BUCKET_COUNT}`;
}

export async function createPairing(
  code: string,
  userId: string,
  createdAt: number,
  expectedAccountId?: string,
): Promise<void> {
  const cx = convexConfig();
  if (!cx) throw new Error("Pairing needs Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  const client = new ConvexHttpClient(cx.url);
  await client.mutation(anyApi.pairings.create, {
    secret: cx.secret,
    code,
    userId,
    createdAt,
    ...(expectedAccountId ? { expectedAccountId } : {}),
  });
}

export async function getPairing(code: string, now = Date.now()): Promise<PairingRow | null> {
  const cx = convexConfig();
  if (!cx) return null;
  const client = new ConvexHttpClient(cx.url);
  return (await client.mutation(anyApi.pairings.getByCode, { secret: cx.secret, code, now })) as PairingRow | null;
}

// Non-consuming, globally rate-limited lookup performed before any Anthropic request. A positive
// result is only a preflight: claimPairing still performs the transactional pending→processing CAS
// after token verification, so a racing completion can never write the same code twice.
export async function preflightPairing(
  code: string,
  rateBucket: string,
  now = Date.now(),
): Promise<PairingPreflightResult> {
  const cx = convexConfig();
  if (!cx) throw new Error("Pairing needs Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  const client = new ConvexHttpClient(cx.url);
  return (await client.mutation(anyApi.pairings.preflight, {
    secret: cx.secret,
    code,
    rateBucket,
    now,
  })) as PairingPreflightResult;
}

// Transactional single-use claim. This intentionally stops at "processing": only a later successful
// vault save may publish "done".
export async function claimPairing(code: string, now: number): Promise<ClaimResult> {
  const cx = convexConfig();
  if (!cx) throw new Error("Pairing needs Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  const client = new ConvexHttpClient(cx.url);
  return (await client.mutation(anyApi.pairings.claim, { secret: cx.secret, code, now })) as ClaimResult;
}

// Publish the terminal result. Returns false if the code no longer exists or is no longer processing;
// callers must not report success unless this returns true.
export async function finalizePairing(code: string, result: PairingFinalization): Promise<boolean> {
  const cx = convexConfig();
  if (!cx) throw new Error("Pairing needs Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  const client = new ConvexHttpClient(cx.url);
  return (await client.mutation(anyApi.pairings.finalize, { secret: cx.secret, code, result })) as boolean;
}
