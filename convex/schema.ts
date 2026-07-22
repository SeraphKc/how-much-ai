import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A single encrypted blob holds all accounts. `key` is a fixed identifier so we can
// upsert one row. The app encrypts before writing, so `data` is always ciphertext.
export default defineSchema({
  vault: defineTable({
    key: v.string(),
    data: v.string(),
  }).index("by_key", ["key"]),

  // --- Shared usage cache + single-flight refresh lock --------------------------
  // One row per (tenant, account). `key` is the per-account scoped key the app computes in
  // lib/usage-service. Self-hosted requests use the historical `usage:<accountId>` form.
  //
  // This is the coordination point that fixes the single-use-token race: the dashboard and the
  // Convex cron both read/write this row, and `refreshingUntil` is a compare-and-set lock claimed
  // in a transactional mutation, so only ONE poller ever refreshes an account's token at a time.
  // `usage`/`profile` are opaque JSON strings (the app serializes them), mirroring the vault's
  // store-a-string pattern. Not encrypted: usage percentages/reset times aren't secrets, and no
  // tokens are ever written here.
  usageCache: defineTable({
    key: v.string(),
    usage: v.union(v.string(), v.null()), // JSON of UsageData, or null when never fetched
    profile: v.union(v.string(), v.null()), // JSON of ProfileData | null
    fetchedAt: v.number(), // epoch ms of last successful upstream fetch (0 = never)
    status: v.string(), // "ready" | "reauth" | "stale" | "error"
    cooldownUntil: v.number(), // epoch ms; > now ⇒ serve stale, don't hit upstream
    refreshingUntil: v.number(), // epoch ms; > now ⇒ a holder owns the single-flight lock
    refreshOwner: v.optional(v.string()), // opaque lease owner; makes commit/release fencing-safe
  }).index("by_key", ["key"]),

  // --- Device pairing (hosted "npx" connect flow, Feature B) --------------------
  // One row per issued pairing code. A signed-in user creates a `pending` row (convex/pairings.create);
  // the public "complete" endpoint claims it exactly once (pending → processing), writes the vault, then
  // finalizes it as done or failed. `code` is the bare, normalized 12-char code (lib/pairing-core
  // normalizePairingCode); `userId` is the owner whose vault the paired account joins. No token is EVER
  // stored here — only the resolved `email` after success or a public-safe failure message. Short-lived
  // (10-min TTL) and single-use.
  pairings: defineTable({
    code: v.string(),
    userId: v.string(),
    status: v.string(), // "pending" | "processing" | "done" | "failed" | "expired"
    email: v.optional(v.string()),
    error: v.optional(v.string()),
    expectedAccountId: v.optional(v.string()),
    verificationAttempts: v.optional(v.number()),
    createdAt: v.number(),
    processingAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_user_created", ["userId", "createdAt"]),

  // Distributed fixed-window throttle for the public pairing-complete endpoint. The app HMACs the
  // client address into one of a fixed 16,384 buckets, so no raw address is stored and attacker-
  // controlled cardinality cannot grow this table beyond that fixed bound.
  pairingRateLimits: defineTable({
    key: v.string(),
    count: v.number(),
    resetAt: v.number(),
  }).index("by_key", ["key"]),

  // --- Notifications ------------------------------------------------------------
  // Per-tenant scoping is retained for stored-data compatibility. This edition always reads and
  // writes the stable `default` tenant.
  //
  // `userId` is OPTIONAL so this schema deploys cleanly onto a deployment that already ran the
  // pre-scoping notify feature (whose rows have no userId — Convex would reject a required field).
  // New rows always write userId. Existing rows must be backfilled to "default" once, right after
  // deploying, so the by_user/by_user_key queries below match them:
  //     npx convex run migrations:backfillNotifyUserIds
  // (see convex/migrations.ts). A fresh deployment has no rows and needs no migration.
  //
  // Per-(account, limit) detector state. `key` is `${accountId}::${limitKey}`, unique per tenant.
  // See lib/notify-detect.ts for how these fields drive event detection.
  notifyState: defineTable({
    userId: v.optional(v.string()),
    key: v.string(),
    accountId: v.string(),
    limitKey: v.string(),
    lastResetsAt: v.union(v.string(), v.null()),
    peakPct: v.number(),
    warned: v.boolean(),
    updatedAt: v.number(),
  }).index("by_user_key", ["userId", "key"]),

  // Web Push subscriptions (one per browser/device that opted in). Endpoint is globally unique.
  pushSubscriptions: defineTable({
    userId: v.optional(v.string()),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    createdAt: v.number(),
  })
    .index("by_endpoint", ["endpoint"])
    .index("by_user", ["userId"]),

  // Notification toggles + thresholds. One row per tenant (`key` stays "config").
  notifyConfig: defineTable({
    userId: v.optional(v.string()),
    key: v.string(),
    recovery: v.boolean(),
    warning: v.boolean(),
    everyReset: v.boolean(),
    warnThreshold: v.number(),
    recoveryThreshold: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // One fenced cron lease per tenant. Convex mutations claim this row transactionally so two
  // overlapping scheduler callbacks cannot both detect and deliver the same notification event.
  notificationRuns: defineTable({
    userId: v.string(),
    leaseUntil: v.number(),
    owner: v.optional(v.string()),
    lastStartedAt: v.number(),
    lastCompletedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

});
