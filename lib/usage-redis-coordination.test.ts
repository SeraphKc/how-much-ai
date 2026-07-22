import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoredAccount } from "./types.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { saveAccounts } = await import("./vault.ts");
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalEnv = {
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  CONVEX_URL: process.env.CONVEX_URL,
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  VAULT_ACCESS_SECRET: process.env.VAULT_ACCESS_SECRET,
  VAULT_ENCRYPTION_SECRET: process.env.VAULT_ENCRYPTION_SECRET,
};

before(() => {
  delete process.env.CONVEX_URL;
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.VAULT_ACCESS_SECRET;
  process.env.VAULT_ENCRYPTION_SECRET = "redis-coordination-test-secret";
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "redis-test-token";
});

after(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  moduleHooks.deregister();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("separate Redis-backed server processes cannot spend the same refresh token", async () => {
  const now = 1_910_000_000_000;
  Date.now = () => now;
  const values = new Map<string, string>();
  const locks = new Map<string, { owner: string; expiresAt: number }>();
  let tokenCalls = 0;
  let usageCalls = 0;

  const redisCommand = (parts: unknown[]): unknown => {
    const args = parts as string[];
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    if (args[0] === "SET") {
      values.set(args[1], args[2]);
      return "OK";
    }
    if (args[0] === "DEL") return values.delete(args[1]) ? 1 : 0;
    assert.equal(args[0], "EVAL");
    const script = args[1];

    // Vault compare-and-set.
    if (script.includes("KEYS[3]") && script.includes("ARGV[3]")) {
      const [, , , key, backupKey, proofKey, expected, next, proof] = args;
      const current = values.get(key);
      const missing = expected === "__HMC_VAULT_MISSING__" && current === undefined;
      if (!missing && current !== expected) return 0;
      const storedProof = values.get(proofKey);
      if (storedProof !== undefined && storedProof !== proof) return -1;
      if (storedProof === undefined) values.set(proofKey, proof);
      values.set(backupKey, next);
      values.set(key, next);
      return 1;
    }

    // Exact auxiliary compare-and-set for the encrypted token-recovery generation.
    if (script.includes("local current = redis.call('GET', KEYS[1])")) {
      const [, , , key, expected, next] = args;
      const current = values.get(key);
      const missing = expected === "__HMC_VAULT_MISSING__" && current === undefined;
      if (!missing && current !== expected) return 0;
      values.set(key, next);
      return 1;
    }

    if (script.includes("hmc:usage-claim")) {
      const [, , , cacheKey, lockKey, owner, leaseMs] = args;
      const lock = locks.get(lockKey);
      if (lock && lock.expiresAt > now) return [0, values.get(cacheKey) ?? null];
      locks.set(lockKey, { owner, expiresAt: now + Number(leaseMs) });
      return [1, values.get(cacheKey) ?? null];
    }
    if (script.includes("hmc:usage-renew")) {
      const [, , , lockKey, owner, leaseMs] = args;
      const lock = locks.get(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      lock.expiresAt = now + Number(leaseMs);
      return 1;
    }
    if (script.includes("hmc:usage-commit")) {
      const [, , , cacheKey, lockKey, owner, serialized] = args;
      const lock = locks.get(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      values.set(cacheKey, serialized);
      locks.delete(lockKey);
      return 1;
    }
    if (script.includes("hmc:usage-release")) {
      const [, , , lockKey, owner] = args;
      const lock = locks.get(lockKey);
      if (!lock || lock.owner !== owner) return 0;
      locks.delete(lockKey);
      return 1;
    }
    throw new Error("Unexpected Redis script");
  };

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://redis.example.test") {
      const command = JSON.parse(String(init?.body)) as unknown[];
      return json({ result: redisCommand(command) });
    }
    if (url.includes("/v1/oauth/token")) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      assert.equal(body.refresh_token, "refresh-r0");
      // Give an uncoordinated second module enough time to enter with the same R0. A Redis lease
      // holder has no problem waiting here; the other process simply serves loading/cached data.
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (tokenCalls > 1) return json({ error: "invalid_grant", error_description: "R0 already used" }, 400);
      return json({ access_token: "access-r1", refresh_token: "refresh-r1", expires_in: 28_800 });
    }
    if (url.includes("/api/oauth/usage")) {
      usageCalls += 1;
      return json({ five_hour: { utilization: 12, resets_at: null } });
    }
    if (url.includes("/api/oauth/profile")) return json({ account: { uuid: "redis-account" } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const stored: StoredAccount = {
    id: "redis-account",
    email: "redis@example.com",
    plan: "Max",
    addedAt: now - 1000,
    tokens: { accessToken: "access-r0", refreshToken: "refresh-r0", expiresAt: now - 1 },
  };
  await saveAccounts("default", [stored]);
  const blankBrowserSnapshot: StoredAccount = {
    ...stored,
    tokens: { accessToken: "", refreshToken: null, expiresAt: 0 },
  };

  // Query-string module identities give each copy independent module-level maps, modeling two
  // serverless workers while retaining the same remote Redis and encrypted vault.
  const workerA = await import(`./usage-service.ts?worker=a-${Date.now()}`);
  const workerB = await import(`./usage-service.ts?worker=b-${Date.now()}`);
  const [a, b] = await Promise.all([
    workerA.getAccountUsage("default", stored),
    workerB.getAccountUsage("default", blankBrowserSnapshot),
  ]);

  assert.equal(tokenCalls, 1, "only the Redis lease owner posted the single-use refresh credential");
  assert.equal(usageCalls, 1);
  assert.ok([a.status, b.status].includes("ready"));
  assert.equal(a.status === "reauth" || b.status === "reauth", false);

  const restartedWorker = await import(`./usage-service.ts?worker=restart-${Date.now()}`);
  const afterRestart = await restartedWorker.getAccountUsage("default", stored);
  assert.equal(afterRestart.status, "ready");
  assert.equal(tokenCalls, 1, "the fresh remote cache was reused after process restart");
  assert.equal(usageCalls, 1);
});
