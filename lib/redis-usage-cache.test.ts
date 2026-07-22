import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRedisUsageCache,
  type RedisCommand,
  type RedisUsageCacheRow,
} from "./redis-usage-cache.ts";

// A deterministic, dependency-free model of the tiny Redis subset used by
// createRedisUsageCache. Two cache instances backed by the same model represent two
// different server processes talking to one remote coordination store.
function fakeRedis(start = 1_000_000) {
  let now = start;
  const values = new Map<string, string>();
  const locks = new Map<string, { owner: string; expiresAt: number }>();

  const liveLock = (key: string) => {
    const lock = locks.get(key);
    if (lock && lock.expiresAt <= now) {
      locks.delete(key);
      return null;
    }
    return lock ?? null;
  };

  const command: RedisCommand = async (parts) => {
    const args = parts as string[];
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    if (args[0] === "DEL") {
      const existed = values.delete(args[1]);
      return existed ? 1 : 0;
    }
    assert.equal(args[0], "EVAL");
    const script = args[1];

    if (script.includes("hmc:usage-claim")) {
      const [, , , cacheKey, lockKey, owner, leaseMs] = args;
      const cached = values.get(cacheKey) ?? null;
      if (liveLock(lockKey)) return [0, cached];
      locks.set(lockKey, { owner, expiresAt: now + Number(leaseMs) });
      return [1, cached];
    }
    if (script.includes("hmc:usage-renew")) {
      const [, , , lockKey, owner, leaseMs] = args;
      const lock = liveLock(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      lock.expiresAt = now + Number(leaseMs);
      return 1;
    }
    if (script.includes("hmc:usage-commit")) {
      const [, , , cacheKey, lockKey, owner, serialized] = args;
      const lock = liveLock(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      values.set(cacheKey, serialized);
      locks.delete(lockKey);
      return 1;
    }
    if (script.includes("hmc:usage-release")) {
      const [, , , lockKey, owner] = args;
      const lock = liveLock(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      locks.delete(lockKey);
      return 1;
    }
    if (script.includes("hmc:usage-clear")) {
      const [, , , cacheKey, lockKey] = args;
      values.delete(cacheKey);
      locks.delete(lockKey);
      return 1;
    }
    throw new Error("Unexpected Redis script");
  };

  return {
    command,
    advance(ms: number) {
      now += ms;
    },
  };
}

function row(status: string, fetchedAt = 1_000_000): RedisUsageCacheRow {
  return {
    usage: JSON.stringify({ five_hour: { utilization: 17, resets_at: null } }),
    profile: JSON.stringify({ account: { uuid: "account-1" } }),
    fetchedAt,
    status,
    cooldownUntil: 0,
    refreshingUntil: 123, // commit must normalize this to zero.
  };
}

test("shared Redis cache survives a new process and coalesces simultaneous claims", async () => {
  const redis = fakeRedis();
  const dashboardProcess = createRedisUsageCache(redis.command);
  const cronProcess = createRedisUsageCache(redis.command);

  const [dashboard, cron] = await Promise.all([
    dashboardProcess.claim("tenant::account", "dashboard-owner", 30_000),
    cronProcess.claim("tenant::account", "cron-owner", 30_000),
  ]);
  assert.equal(Number(dashboard.acquired) + Number(cron.acquired), 1, "exactly one process owns the refresh token");

  const winner = dashboard.acquired
    ? { cache: dashboardProcess, owner: "dashboard-owner" }
    : { cache: cronProcess, owner: "cron-owner" };
  assert.equal(await winner.cache.commit("tenant::account", winner.owner, row("ready")), true);

  // A newly constructed client has no process-local state, yet sees the durable result.
  const afterRestart = createRedisUsageCache(redis.command);
  assert.deepEqual(await afterRestart.get("tenant::account"), {
    ...row("ready", 1_000_000),
    refreshingUntil: 0,
  });
});

test("an expired owner cannot commit or release after another process reclaims the lease", async () => {
  const redis = fakeRedis();
  const processA = createRedisUsageCache(redis.command);
  const processB = createRedisUsageCache(redis.command);
  const key = "tenant::single-use-refresh";

  assert.equal((await processA.claim(key, "owner-a", 30_000)).acquired, true);
  redis.advance(30_001);
  assert.equal((await processB.claim(key, "owner-b", 30_000)).acquired, true);

  // A's slow upstream request finishes after its lease expired. Fencing by owner must make both
  // late operations harmless: A cannot publish stale data or clear B's live lease.
  assert.equal(await processA.commit(key, "owner-a", row("stale-a")), false);
  assert.equal(await processA.release(key, "owner-a"), false);

  // B still owns the lease and can safely publish the only accepted result.
  assert.equal(await processB.commit(key, "owner-b", row("ready-b", 1_030_001)), true);
  assert.equal((await processA.get(key))?.status, "ready-b");
});

test("renewing a lease keeps another process from spending the refresh token during a slow request", async () => {
  const redis = fakeRedis();
  const slowProcess = createRedisUsageCache(redis.command);
  const contender = createRedisUsageCache(redis.command);
  const key = "tenant::slow-upstream";

  assert.equal((await slowProcess.claim(key, "slow-owner", 30_000)).acquired, true);
  redis.advance(25_000);
  assert.equal(await slowProcess.renew(key, "slow-owner", 30_000), true);
  redis.advance(10_000); // Past the original lease, but inside the renewed lease.
  assert.equal((await contender.claim(key, "contender", 30_000)).acquired, false);

  assert.equal(await slowProcess.commit(key, "slow-owner", row("ready", 1_035_000)), true);
  assert.equal((await contender.get(key))?.status, "ready");
});

test("clearing a reconnected account fences out the owner of the previous credential", async () => {
  const redis = fakeRedis();
  const oldProcess = createRedisUsageCache(redis.command);
  const newProcess = createRedisUsageCache(redis.command);
  const key = "tenant::reconnected";

  assert.equal((await oldProcess.claim(key, "old-credential-owner", 30_000)).acquired, true);
  await newProcess.clear(key);
  assert.equal(
    await oldProcess.commit(key, "old-credential-owner", row("reauth-from-old-credential")),
    false,
  );
  assert.equal((await newProcess.claim(key, "new-credential-owner", 30_000)).acquired, true);
});
