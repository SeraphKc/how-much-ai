import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
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

const originalFetch = globalThis.fetch;
const envKeys = [
  "VAULT_DATA_DIR",
  "VAULT_ENCRYPTION_SECRET",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let dataDir = "";

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-file-coordination-"));
  for (const key of envKeys) delete process.env[key];
  process.env.VAULT_DATA_DIR = dataDir;
  process.env.VAULT_ENCRYPTION_SECRET = "file-coordination-test-secret";
});

after(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  moduleHooks.deregister();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("independent local server modules cannot spend the same refresh token", async () => {
  const { saveAccounts, loadAccounts } = await import("./vault.ts");
  const now = Date.now();
  const stored: StoredAccount = {
    id: "file-account",
    email: "file@example.com",
    plan: "Max",
    addedAt: now - 1000,
    credentialKind: "rotating",
    tokens: { accessToken: "access-r0", refreshToken: "refresh-r0", expiresAt: now - 1 },
  };
  await saveAccounts("default", [stored]);

  let tokenCalls = 0;
  let usageCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/oauth/token")) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      assert.equal(body.refresh_token, "refresh-r0");
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (tokenCalls > 1) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-r1", refresh_token: "refresh-r1", expires_in: 28_800 });
    }
    if (url.includes("/api/oauth/usage")) {
      usageCalls += 1;
      return json({ five_hour: { utilization: 18, resets_at: null } });
    }
    if (url.includes("/api/oauth/profile")) return json({ account: { uuid: stored.id, email: stored.email } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const workerA = await import(`./usage-service.ts?file-worker=a-${now}`);
  const workerB = await import(`./usage-service.ts?file-worker=b-${now}`);
  const [a, b] = await Promise.all([
    workerA.getAccountUsage("default", stored),
    workerB.getAccountUsage("default", stored),
  ]);

  assert.equal(tokenCalls, 1, "the filesystem lease allowed exactly one refresh-token POST");
  assert.equal(usageCalls, 2, "each process may read usage after adopting the durable replacement");
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  assert.equal((await loadAccounts("default"))[0].tokens.refreshToken, "refresh-r1");
});
