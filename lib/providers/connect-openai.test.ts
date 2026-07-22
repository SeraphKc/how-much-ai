import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promises as fs, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(path.join(projectRoot, `${specifier.slice(2)}.ts`)).href, context);
    }
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
const originalEnv = { ...process.env };
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-connect-openai-"));

for (const key of [
  "APP_PASSWORD",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]) {
  delete process.env[key];
}
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "connect-openai-test-secret";

const { POST } = await import("../../app/api/connect/manual/route.ts");
const { loadAccounts, saveAccounts } = await import("../vault.ts");

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256", typ: "JWT" })}.${b(payload)}.sig`;
}
const accessToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "pro" },
  exp: 9_999_999_999,
});

before(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/wham/usage")) {
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

test("manual connect saves an OpenAI account with provider, id, and plan from /wham/usage", async () => {
  await saveAccounts("default", []);
  const tokens = { accessToken, refreshToken: "rt-openai", expiresAt: Date.now() + 86_400_000 };
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", tokens }),
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    id: string;
    plan: string;
    usage?: { seven_day?: unknown };
    profile: unknown;
  };
  assert.equal(body.ok, true);
  assert.equal(body.id, "openai-acc-1");
  assert.equal(body.plan, "ChatGPT Pro");
  assert.equal(body.profile, null);
  assert.ok(body.usage?.seven_day, "usage snapshot returned");

  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].provider, "openai");
  assert.equal(stored[0].credentialKind, "rotating");
  assert.deepEqual(stored[0].tokens, tokens);
});

test("manual connect rejects an unsupported provider", async () => {
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "bogus", tokens: { accessToken, refreshToken: "x", expiresAt: 1 } }),
    }),
  );
  assert.equal(response.status, 400);
});
