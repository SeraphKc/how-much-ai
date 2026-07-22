import { internalMutation } from "./_generated/server";

// One-time upgrade for deployments that ran the notifications feature BEFORE per-user scoping.
// Rows written by the old code have no `userId`; the new by_user / by_user_key queries filter on
// userId, so those legacy rows would go unmatched (config would reset to defaults, detector state
// would look brand-new, push subscriptions would appear gone). This backfills every such row to the
// shared "default" tenant — exactly where password/open mode reads and writes — restoring continuity.
//
// Run once, right after `npx convex deploy`, on any deployment that already used notifications:
//     npx convex run migrations:backfillNotifyUserIds
// Idempotent: it only touches rows still missing userId, so re-running is a no-op. A fresh
// deployment (no rows) needs nothing.
export const backfillNotifyUserIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tables = ["notifyState", "notifyConfig", "pushSubscriptions"] as const;
    const patched: Record<string, number> = {};
    for (const table of tables) {
      let count = 0;
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if ((row as { userId?: string }).userId === undefined) {
          await ctx.db.patch(row._id, { userId: "default" });
          count++;
        }
      }
      patched[table] = count;
    }
    return patched;
  },
});
