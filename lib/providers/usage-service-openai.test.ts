import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promises as fs, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoredAccount } from "../types.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
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

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wham-usage.json", import.meta.url), "utf8"));
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

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256", typ: "JWT" })}.${b(payload)}.sig`;
}
const accessToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-openai-1", chatgpt_plan_type: "pro" },
  exp: 9_999_999_999,
});

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-openai-usage-"));
  for (const key of envKeys) delete process.env[key];
  process.env.VAULT_DATA_DIR = dataDir;
  process.env.VAULT_ENCRYPTION_SECRET = "openai-usage-test-secret";
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

test("getAccountUsage reads OpenAI usage without spending inference or refreshing a fresh token", async () => {
  const { saveAccounts, loadAccounts } = await import("../vault.ts");
  const { getAccountUsage } = await import("../usage-service.ts");
  const now = Date.now();
  const account: StoredAccount = {
    id: "openai-acc-openai-1",
    email: "codex@example.com",
    plan: "ChatGPT Pro",
    addedAt: now - 1000,
    credentialKind: "rotating",
    provider: "openai",
    tokens: { accessToken, refreshToken: "rt-openai-0", expiresAt: now + 24 * 60 * 60 * 1000 },
  };
  await saveAccounts("default", [account]);

  // The provider survives the vault round-trip.
  assert.equal((await loadAccounts("default"))[0].provider, "openai");

  let usageCalls = 0;
  let tokenCalls = 0;
  let sawBearer = "";
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const url = String(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: accessToken, refresh_token: "rt-openai-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/wham/usage")) {
      usageCalls += 1;
      sawBearer = String((init as { headers?: Record<string, string> })?.headers?.Authorization ?? "");
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  const result = await getAccountUsage("default", account);
  assert.equal(result.status, "ready");
  assert.equal(result.usage?.seven_day?.utilization, 3);
  assert.equal(result.profile, null); // OpenAI keeps its connect-time plan; no profile round-trip
  assert.equal(usageCalls, 1);
  assert.equal(tokenCalls, 0, "a fresh access token must not be refreshed");
  assert.equal(sawBearer, `Bearer ${accessToken}`);
});
