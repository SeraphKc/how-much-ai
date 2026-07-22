import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Shared usage cache + single-flight refresh lock. Secret-gated exactly like convex/vault.ts:
// these functions are reachable by anyone who knows the deployment URL, so the app's server proves
// itself with VAULT_ACCESS_SECRET (set in this Convex deployment's env). Nothing sensitive lives
// here (no tokens — only usage percentages and reset times), but it still shouldn't be world-
// writable, or an attacker could wedge every account's refresh lock.
//
// `key` is the per-account scoped key from lib/usage-service (usageCacheKey).
function assertSecret(secret: string) {
  const expected = process.env.VAULT_ACCESS_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

const REFRESH_LOCK_MS = 120_000; // Mirror of lib/usage-cache-core REFRESH_LOCK_MS (kept in sync by hand).

export const get = query({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) return null;
    const { usage, profile, fetchedAt, status, cooldownUntil, refreshingUntil, refreshOwner } = row;
    return { usage, profile, fetchedAt, status, cooldownUntil, refreshingUntil, refreshOwner };
  },
});

// Compare-and-set claim of the single-flight refresh lock. TRANSACTIONAL: Convex serializes
// mutations on the same document, so of two racing callers exactly one sees `refreshingUntil <= now`
// and wins. The winner gets `acquired: true`; the loser gets `acquired: false` plus the current
// cached snapshot to serve instead of making a second upstream call. This is the primitive that
// actually prevents the single-use-token race. Mirrors lib/usage-cache-core claimDecision by hand.
export const claim = mutation({
  args: { secret: v.string(), key: v.string(), owner: v.string() },
  handler: async (ctx, { secret, key, owner }) => {
    assertSecret(secret);
    // Lease decisions use the storage mutation's clock. A skewed or malicious app worker cannot
    // prematurely steal another worker's lease or keep its own lease alive indefinitely.
    const now = Date.now();
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();

    const cached = row
      ? {
          usage: row.usage,
          profile: row.profile,
          fetchedAt: row.fetchedAt,
          status: row.status,
          cooldownUntil: row.cooldownUntil,
          refreshingUntil: row.refreshingUntil,
        }
      : null;

    if (row && row.refreshingUntil > now) {
      return { acquired: false, cached };
    }

    const refreshingUntil = now + REFRESH_LOCK_MS;
    if (row) {
      await ctx.db.patch(row._id, { refreshingUntil, refreshOwner: owner });
    } else {
      await ctx.db.insert("usageCache", {
        key,
        usage: null,
        profile: null,
        fetchedAt: 0,
        status: "loading",
        cooldownUntil: 0,
        refreshingUntil,
        refreshOwner: owner,
      });
    }
    return { acquired: true, cached };
  },
});

// Extend only the caller's own lease. If it expired and another worker reclaimed the row, the old
// worker receives false and can no longer commit or release the new owner's work.
export const renew = mutation({
  args: { secret: v.string(), key: v.string(), owner: v.string() },
  handler: async (ctx, { secret, key, owner }) => {
    assertSecret(secret);
    const now = Date.now();
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row || row.refreshOwner !== owner) return false;
    await ctx.db.patch(row._id, { refreshingUntil: now + REFRESH_LOCK_MS });
    return true;
  },
});

// Write results and RELEASE the lock (refreshingUntil = 0). Called by the lock holder after a
// fetch/refresh — on success (fresh usage, status ready, cooldownUntil 0) or after a hard rejection
// (keep prior usage, set status reauth/stale + a cooldown). Any field left undefined is preserved.
export const commit = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    owner: v.string(),
    usage: v.optional(v.union(v.string(), v.null())),
    profile: v.optional(v.union(v.string(), v.null())),
    fetchedAt: v.optional(v.number()),
    status: v.string(),
    cooldownUntil: v.number(),
  },
  handler: async (ctx, { secret, key, owner, usage, profile, fetchedAt, status, cooldownUntil }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row || row.refreshOwner !== owner) return false;
    const patch: Record<string, unknown> = { status, cooldownUntil, refreshingUntil: 0, refreshOwner: undefined };
    if (usage !== undefined) patch.usage = usage;
    if (profile !== undefined) patch.profile = profile;
    if (fetchedAt !== undefined) patch.fetchedAt = fetchedAt;
    await ctx.db.patch(row._id, patch);
    return true;
  },
});

// Release the lock without changing data — for error paths where the holder bailed before writing
// results, so the account isn't wedged for the full lock window.
export const release = mutation({
  args: { secret: v.string(), key: v.string(), owner: v.string() },
  handler: async (ctx, { secret, key, owner }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row || row.refreshOwner !== owner) return false;
    await ctx.db.patch(row._id, { refreshingUntil: 0, refreshOwner: undefined });
    return true;
  },
});

// A newly connected credential invalidates any prior in-flight lease and cached reauth state. An
// old holder is fenced out because its owner token is removed here.
export const reset = mutation({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("usageCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        status: "loading",
        cooldownUntil: 0,
        refreshingUntil: 0,
        refreshOwner: undefined,
      });
    }
    return null;
  },
});
