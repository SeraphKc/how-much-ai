import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  decidePairingClaim,
  pairingRecordReclaimable,
  STALE_PAIRING_ERROR,
} from "./pairingState";

// Device-pairing store for the hosted "npx" connect flow (Feature B). Secret-gated exactly like
// convex/vault.ts: these functions are reachable by anyone who knows the deployment URL, so the app's
// server proves itself with VAULT_ACCESS_SECRET (set in this Convex deployment's env). No tokens are
// ever stored here — only a code, its owner (userId), status, and the resolved email for confirmation.
//
// `code` is the bare, normalized 12-char pairing code (lib/pairing-core normalizePairingCode). The
// TTL + the single-use claim below mirror lib/pairing-core by hand (Convex modules and the Next app
// don't share a module graph), so the tested rule and this transactional claim agree.
function assertSecret(secret: string) {
  const expected = process.env.VAULT_ACCESS_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;
const MAX_PAIRING_RECORDS_PER_USER = 50;
const MAX_PAIRING_PRUNE_SCAN = 200;
const RATE_BUCKET_COUNT = 16_384;
const RATE_LIMIT_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const MAX_VERIFICATION_ATTEMPTS_PER_CODE = 5;

function assertCode(code: string) {
  if (!PAIRING_CODE_PATTERN.test(code)) throw new Error("Invalid pairing code");
}

function assertTime(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field}`);
}

// A signed-in user issues a fresh pending code (one per "Connect account" click).
export const create = mutation({
  args: {
    secret: v.string(),
    code: v.string(),
    userId: v.string(),
    createdAt: v.number(),
    expectedAccountId: v.optional(v.string()),
  },
  handler: async (ctx, { secret, code, userId, createdAt, expectedAccountId }) => {
    assertSecret(secret);
    assertCode(code);
    assertTime(createdAt, "pairing creation time");
    if (!userId.trim() || userId.length > 512) throw new Error("Invalid pairing owner");
    if (expectedAccountId !== undefined && (!expectedAccountId.trim() || expectedAccountId.length > 200)) {
      throw new Error("Invalid expected account id");
    }

    // Keep each tenant's short-lived records bounded. Terminal/expired/stale rows are reclaimed only
    // when the cap is reached, preserving ordinary completion status long enough for browser polls.
    const oldRows = await ctx.db
      .query("pairings")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("asc")
      .take(MAX_PAIRING_PRUNE_SCAN);
    if (oldRows.length >= MAX_PAIRING_RECORDS_PER_USER) {
      for (const row of oldRows) {
        if (pairingRecordReclaimable(row, createdAt)) await ctx.db.delete(row._id);
      }
      const stillAtCap = await ctx.db
        .query("pairings")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .take(MAX_PAIRING_RECORDS_PER_USER);
      if (stillAtCap.length >= MAX_PAIRING_RECORDS_PER_USER) {
        throw new Error("Too many active pairing attempts. Wait for an existing code to expire.");
      }
    }

    const collision = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (collision) throw new Error("Pairing code collision. Start again.");
    await ctx.db.insert("pairings", {
      code,
      userId,
      status: "pending",
      verificationAttempts: 0,
      createdAt,
      ...(expectedAccountId ? { expectedAccountId } : {}),
    });
    return null;
  },
});

// Public completion preflight: increment the distributed fixed-window bucket, then inspect (but do
// not claim) the code. This always happens before Anthropic sees a submitted credential. The later
// claim mutation remains the only operation that can move pending→processing.
export const preflight = mutation({
  args: { secret: v.string(), code: v.string(), rateBucket: v.string(), now: v.number() },
  handler: async (ctx, { secret, code, rateBucket, now }) => {
    assertSecret(secret);
    assertCode(code);
    assertTime(now, "preflight time");
    const bucketNumber = Number(rateBucket.slice(1));
    if (
      !rateBucket.startsWith("b") ||
      !Number.isSafeInteger(bucketNumber) ||
      bucketNumber < 0 ||
      bucketNumber >= RATE_BUCKET_COUNT ||
      rateBucket !== `b${bucketNumber}`
    ) {
      throw new Error("Invalid rate-limit bucket");
    }

    const rate = await ctx.db
      .query("pairingRateLimits")
      .withIndex("by_key", (q) => q.eq("key", rateBucket))
      .unique();
    if (!rate || rate.resetAt <= now) {
      if (rate) await ctx.db.patch(rate._id, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      else await ctx.db.insert("pairingRateLimits", { key: rateBucket, count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else if (rate.count >= RATE_LIMIT_ATTEMPTS) {
      return {
        ok: false as const,
        reason: "rate_limited" as const,
        retryAfterSeconds: Math.max(1, Math.ceil((rate.resetAt - now) / 1000)),
      };
    } else {
      await ctx.db.patch(rate._id, { count: rate.count + 1 });
    }

    const row = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const decision = decidePairingClaim(row, now);
    if (!decision.ok) return { ok: false as const, reason: decision.reason };
    const attempts =
      typeof row.verificationAttempts === "number" && Number.isFinite(row.verificationAttempts)
        ? row.verificationAttempts
        : 0;
    if (attempts >= MAX_VERIFICATION_ATTEMPTS_PER_CODE) {
      return { ok: false as const, reason: "attempts_exhausted" as const };
    }
    await ctx.db.patch(row._id, { verificationAttempts: attempts + 1 });
    return { ok: true as const };
  },
});

// Read a pairing for the owner's status poll and settle stale non-terminal states transactionally.
// The private expected account id is intentionally never included in this status projection.
export const getByCode = mutation({
  args: { secret: v.string(), code: v.string(), now: v.number() },
  handler: async (ctx, { secret, code, now }) => {
    assertSecret(secret);
    assertCode(code);
    assertTime(now, "pairing lookup time");
    const row = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!row) return null;
    const decision = decidePairingClaim(row, now);
    let status = row.status;
    let error = row.error ?? null;
    if (!decision.ok && decision.transition) {
      status = decision.transition;
      const patch =
        decision.transition === "failed"
          ? { status, error: STALE_PAIRING_ERROR }
          : { status };
      await ctx.db.patch(row._id, patch);
      if (decision.transition === "failed") error = STALE_PAIRING_ERROR;
    }
    return {
      userId: row.userId,
      status,
      email: row.email ?? null,
      error,
      createdAt: row.createdAt,
      processingAt: row.processingAt ?? null,
    };
  },
});

// Phase 1 of completion: claim a code without claiming success. TRANSACTIONAL: Convex serializes
// mutations on the same document, so of two racing callers exactly one sees "pending" and moves it to
// "processing". Only that caller may write the owner's vault; every concurrent caller is rejected
// before the save. Expired-by-TTL codes are marked "expired" and rejected.
export const claim = mutation({
  args: { secret: v.string(), code: v.string(), now: v.number() },
  handler: async (ctx, { secret, code, now }) => {
    assertSecret(secret);
    assertCode(code);
    assertTime(now, "pairing claim time");
    const row = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const decision = decidePairingClaim(row, now);
    if (!decision.ok) {
      if (decision.transition === "expired") await ctx.db.patch(row._id, { status: "expired" });
      if (decision.transition === "failed") {
        await ctx.db.patch(row._id, { status: "failed", error: STALE_PAIRING_ERROR });
      }
      return { ok: false as const, reason: decision.reason };
    }
    await ctx.db.patch(row._id, { status: "processing", processingAt: now });
    return {
      ok: true as const,
      userId: row.userId,
      ...(row.expectedAccountId ? { expectedAccountId: row.expectedAccountId } : {}),
    };
  },
});

// Phase 2 of completion: publish a terminal state only after the vault attempt finishes. A successful
// save records the display-only email and flips processing→done. A rejected/failed save records only
// a deliberately public-safe error and flips processing→failed. The processing precondition prevents
// late or duplicated finalizers from rewriting an already-terminal result.
export const finalize = mutation({
  args: {
    secret: v.string(),
    code: v.string(),
    result: v.union(
      v.object({ status: v.literal("done"), email: v.string() }),
      v.object({ status: v.literal("failed"), error: v.string() }),
    ),
  },
  handler: async (ctx, { secret, code, result }) => {
    assertSecret(secret);
    assertCode(code);
    if (result.status === "done" && result.email.length > 512) throw new Error("Invalid pairing email");
    if (result.status === "failed" && result.error.length > 1_000) throw new Error("Invalid pairing error");
    const row = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!row || row.status !== "processing") return false;

    if (result.status === "done") {
      await ctx.db.patch(row._id, { status: "done", email: result.email });
    } else {
      await ctx.db.patch(row._id, { status: "failed", error: result.error });
    }
    return true;
  },
});
