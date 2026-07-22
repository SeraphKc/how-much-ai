import { query, mutation, internalAction } from "./_generated/server";
import { v } from "convex/values";

const CONFIG_KEY = "config";
const NOTIFICATION_LEASE_MS = 10 * 60_000; // Mirror lib/notification-lease-core.ts.

// Same shared-secret gate as vault.ts: these functions are reachable by anyone who knows the
// deployment URL, so the app's server proves itself with VAULT_ACCESS_SECRET (set in this
// Convex deployment's env). Notification state is not as sensitive as the token vault, but it
// still shouldn't be world-readable or world-writable.
//
// Every function retains an explicit `userId` storage scope for upgrade compatibility. The
// self-hosted app always passes `default` and never accepts this value from a browser client.
function assertSecret(secret: string) {
  const expected = process.env.VAULT_ACCESS_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

// Defaults mirror lib/notify-detect.ts DEFAULT_TOGGLES / DEFAULT_THRESHOLDS. Kept in sync by
// hand because Convex modules and the Next app don't share a module graph.
const DEFAULT_CONFIG = {
  recovery: true,
  warning: true,
  everyReset: false,
  warnThreshold: 90,
  recoveryThreshold: 80,
};

// --- config -------------------------------------------------------------------

export const getConfig = query({
  args: { secret: v.string(), userId: v.string() },
  handler: async (ctx, { secret, userId }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("notifyConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return DEFAULT_CONFIG;
    const { recovery, warning, everyReset, warnThreshold, recoveryThreshold } = row;
    return { recovery, warning, everyReset, warnThreshold, recoveryThreshold };
  },
});

export const setConfig = mutation({
  args: {
    secret: v.string(),
    userId: v.string(),
    recovery: v.boolean(),
    warning: v.boolean(),
    everyReset: v.boolean(),
    warnThreshold: v.number(),
    recoveryThreshold: v.number(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const { userId, recovery, warning, everyReset, warnThreshold, recoveryThreshold } = args;
    const patch = { recovery, warning, everyReset, warnThreshold, recoveryThreshold, updatedAt: Date.now() };
    const row = await ctx.db
      .query("notifyConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("notifyConfig", { userId, key: CONFIG_KEY, ...patch });
    return null;
  },
});

// --- detector state -----------------------------------------------------------

export const getStates = query({
  args: { secret: v.string(), userId: v.string() },
  handler: async (ctx, { secret, userId }) => {
    assertSecret(secret);
    const rows = await ctx.db
      .query("notifyState")
      .withIndex("by_user_key", (q) => q.eq("userId", userId))
      .collect();
    return rows.map(({ key, accountId, limitKey, lastResetsAt, peakPct, warned }) => ({
      key,
      accountId,
      limitKey,
      lastResetsAt,
      peakPct,
      warned,
    }));
  },
});

export const putStates = mutation({
  args: {
    secret: v.string(),
    userId: v.string(),
    states: v.array(
      v.object({
        key: v.string(),
        accountId: v.string(),
        limitKey: v.string(),
        lastResetsAt: v.union(v.string(), v.null()),
        peakPct: v.number(),
        warned: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, { secret, userId, states }) => {
    assertSecret(secret);
    // Replace the tenant snapshot transactionally. This prunes rows for removed accounts and limits
    // that disappeared from a successful upstream reading. The app includes prior rows for accounts
    // whose reading was temporarily unavailable, so outages do not erase their detector history.
    const current = await ctx.db
      .query("notifyState")
      .withIndex("by_user_key", (q) => q.eq("userId", userId))
      .collect();
    const incomingKeys = new Set(states.map((state) => state.key));
    for (const row of current) {
      if (!incomingKeys.has(row.key)) await ctx.db.delete(row._id);
    }
    for (const s of states) {
      const existing = await ctx.db
        .query("notifyState")
        .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", s.key))
        .unique();
      const doc = { ...s, userId, updatedAt: Date.now() };
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert("notifyState", doc);
    }
    return null;
  },
});

// --- push subscriptions -------------------------------------------------------

export const listSubscriptions = query({
  args: { secret: v.string(), userId: v.string() },
  handler: async (ctx, { secret, userId }) => {
    assertSecret(secret);
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  },
});

export const addSubscription = mutation({
  args: { secret: v.string(), userId: v.string(), endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, { secret, userId, endpoint, p256dh, auth }) => {
    assertSecret(secret);
    // Endpoint is globally unique (device-scoped). If a device re-subscribes under a different
    // tenant, re-home it to the current user.
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (!existing || existing.userId !== userId) {
      const tenantSubscriptions = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(20);
      if (tenantSubscriptions.length >= 20) throw new Error("This account already has 20 notification devices.");
    }
    if (existing) await ctx.db.patch(existing._id, { userId, p256dh, auth });
    else await ctx.db.insert("pushSubscriptions", { userId, endpoint, p256dh, auth, createdAt: Date.now() });
    return null;
  },
});

export const removeSubscription = mutation({
  args: { secret: v.string(), userId: v.string(), endpoint: v.string() },
  handler: async (ctx, { secret, userId, endpoint }) => {
    assertSecret(secret);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    // Only the owning tenant may remove its subscription.
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
    return null;
  },
});

// --- tenant cron lease --------------------------------------------------------

// Transactional compare-and-set. Concurrent mutations touching the same tenant row are retried by
// Convex, so exactly one scheduler invocation can own that tenant's detect/deliver cycle.
export const claimRun = mutation({
  args: { secret: v.string(), userId: v.string(), owner: v.string() },
  handler: async (ctx, { secret, userId, owner }) => {
    assertSecret(secret);
    const now = Date.now();
    const row = await ctx.db
      .query("notificationRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row && row.leaseUntil > now) {
      return { acquired: false, leaseUntil: row.leaseUntil };
    }
    const leaseUntil = now + NOTIFICATION_LEASE_MS;
    if (row) {
      await ctx.db.patch(row._id, { owner, leaseUntil, lastStartedAt: now });
    } else {
      await ctx.db.insert("notificationRuns", { userId, owner, leaseUntil, lastStartedAt: now });
    }
    return { acquired: true, leaseUntil };
  },
});

// Only the active owner can extend its lease. A stale invocation is fenced out after another
// worker reclaims the row.
export const renewRun = mutation({
  args: { secret: v.string(), userId: v.string(), owner: v.string() },
  handler: async (ctx, { secret, userId, owner }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("notificationRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row || row.owner !== owner) return false;
    await ctx.db.patch(row._id, { leaseUntil: Date.now() + NOTIFICATION_LEASE_MS });
    return true;
  },
});

export const releaseRun = mutation({
  args: { secret: v.string(), userId: v.string(), owner: v.string() },
  handler: async (ctx, { secret, userId, owner }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("notificationRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row || row.owner !== owner) return false;
    const now = Date.now();
    await ctx.db.patch(row._id, { owner: undefined, leaseUntil: 0, lastCompletedAt: now });
    return true;
  },
});

// --- cron trigger -------------------------------------------------------------
// The heavy lifting (decrypt vault, call Anthropic, dispatch) lives in the Next app, which has
// APP_PASSWORD and the Node crypto/storage code. This action is just the scheduled poke: it
// calls the app's /api/cron/check with the shared CRON_SECRET. Set APP_URL + CRON_SECRET in
// this deployment's env (`npx convex env set …`).
export const pingCheck = internalAction({
  args: {},
  handler: async () => {
    const appUrl = process.env.APP_URL;
    const cronSecret = process.env.CRON_SECRET;
    if (!appUrl || !cronSecret) {
      console.warn("[notify] APP_URL or CRON_SECRET not set — skipping usage check");
      return null;
    }
    try {
      const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/cron/check`, {
        method: "POST",
        headers: { "x-cron-secret": cronSecret },
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (!res.ok) console.error(`[notify] check failed ${res.status}: ${text.slice(0, 300)}`);
      else console.log(`[notify] check ok: ${text.slice(0, 300)}`);
    } catch (err) {
      console.error("[notify] check request threw", err);
    }
    return null;
  },
});
