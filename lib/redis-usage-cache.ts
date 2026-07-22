// Redis/KV-backed usage cache and ownership-safe single-flight lease. The app talks to Upstash's
// REST protocol (also exposed by Vercel KV). Every lock transition is one Lua script so separate
// serverless instances cannot both own, extend, commit, or release the same refresh lease.

export interface RedisRestConfig {
  url: string;
  token: string;
}

export interface RedisUsageCacheRow {
  usage: string | null;
  profile: string | null;
  fetchedAt: number;
  status: string;
  cooldownUntil: number;
  refreshingUntil: number;
}

export type RedisCommand = (command: unknown[]) => Promise<unknown>;

export function redisUsageConfig(): RedisRestConfig | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function redisRestCommand(config: RedisRestConfig): RedisCommand {
  return async (command) => {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`usage coordination storage error ${response.status}`);
    const body = (await response.json()) as { result?: unknown };
    return body.result ?? null;
  };
}

const CLAIM_SCRIPT = `-- hmc:usage-claim
local cached = redis.call('GET', KEYS[1])
local acquired = redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2])
if acquired then return {1, cached} end
return {0, cached}`;

const RENEW_SCRIPT = `-- hmc:usage-renew
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])`;

const COMMIT_SCRIPT = `-- hmc:usage-commit
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('DEL', KEYS[2])
return 1`;

const RELEASE_SCRIPT = `-- hmc:usage-release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

// A newly connected credential invalidates both the old cached reauth/cooldown verdict and any
// in-flight owner working with the previous credential generation. Deleting both keys atomically
// ensures that old owner is fenced out from publishing after reset.
const CLEAR_SCRIPT = `-- hmc:usage-clear
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1`;

function cacheKey(key: string): string {
  return `hmc:usage-cache:v1:${key}`;
}

function lockKey(key: string): string {
  return `hmc:usage-lock:v1:${key}`;
}

function parseRow(raw: unknown): RedisUsageCacheRow | null {
  if (typeof raw !== "string") return null;
  try {
    const row = JSON.parse(raw) as Partial<RedisUsageCacheRow>;
    if (
      (row.usage !== null && typeof row.usage !== "string") ||
      (row.profile !== null && typeof row.profile !== "string") ||
      typeof row.fetchedAt !== "number" ||
      !Number.isFinite(row.fetchedAt) ||
      typeof row.status !== "string" ||
      typeof row.cooldownUntil !== "number" ||
      !Number.isFinite(row.cooldownUntil)
    ) {
      return null;
    }
    return {
      usage: row.usage ?? null,
      profile: row.profile ?? null,
      fetchedAt: row.fetchedAt,
      status: row.status,
      cooldownUntil: row.cooldownUntil,
      refreshingUntil:
        typeof row.refreshingUntil === "number" && Number.isFinite(row.refreshingUntil)
          ? row.refreshingUntil
          : 0,
    };
  } catch {
    return null;
  }
}

export interface RedisUsageCache {
  get(key: string): Promise<RedisUsageCacheRow | null>;
  claim(
    key: string,
    owner: string,
    leaseMs: number,
  ): Promise<{ acquired: boolean; cached: RedisUsageCacheRow | null }>;
  renew(key: string, owner: string, leaseMs: number): Promise<boolean>;
  commit(key: string, owner: string, row: RedisUsageCacheRow): Promise<boolean>;
  release(key: string, owner: string): Promise<boolean>;
  clear(key: string): Promise<void>;
}

export function createRedisUsageCache(command: RedisCommand): RedisUsageCache {
  return {
    async get(key) {
      return parseRow(await command(["GET", cacheKey(key)]));
    },
    async claim(key, owner, leaseMs) {
      const result = await command([
        "EVAL",
        CLAIM_SCRIPT,
        "2",
        cacheKey(key),
        lockKey(key),
        owner,
        String(leaseMs),
      ]);
      if (!Array.isArray(result)) throw new Error("usage coordination returned an invalid claim result");
      return { acquired: Number(result[0]) === 1, cached: parseRow(result[1]) };
    },
    async renew(key, owner, leaseMs) {
      const result = await command(["EVAL", RENEW_SCRIPT, "1", lockKey(key), owner, String(leaseMs)]);
      return Number(result) === 1;
    },
    async commit(key, owner, row) {
      const result = await command([
        "EVAL",
        COMMIT_SCRIPT,
        "2",
        cacheKey(key),
        lockKey(key),
        owner,
        JSON.stringify({ ...row, refreshingUntil: 0 }),
      ]);
      return Number(result) === 1;
    },
    async release(key, owner) {
      const result = await command(["EVAL", RELEASE_SCRIPT, "1", lockKey(key), owner]);
      return Number(result) === 1;
    },
    async clear(key) {
      await command(["EVAL", CLEAR_SCRIPT, "2", cacheKey(key), lockKey(key)]);
    },
  };
}

export function createRedisUsageCacheFromConfig(config: RedisRestConfig): RedisUsageCache {
  return createRedisUsageCache(redisRestCommand(config));
}
