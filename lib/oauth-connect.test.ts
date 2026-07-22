import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
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

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-oauth-connect-"));
for (const key of [
  "APP_PASSWORD",
  "AUTH_SECRET",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "oauth-connect-test-secret";

const { POST } = await import("../app/api/connect/oauth/route.ts");
const { CLAUDE_SUBSCRIPTION_OAUTH } = await import("./anthropic.ts");
const { loadAccounts, saveAccounts } = await import("./vault.ts");

const ACCESS_TOKEN = "sk-ant-oat01-oauth-access-secret";
const REFRESH_TOKEN = "oauth-refresh-secret";
const CODE = "authorization-code-once";
const VERIFIER = "v".repeat(43);
const STATE = "state_ABC123";

type FetchMode = "success" | "token_500" | "network_failure" | "missing_refresh" | "reduced_scope";
let mode: FetchMode = "success";
let profileAccountId = "acct-oauth";
let calls: Array<{ url: string; init?: RequestInit }> = [];

before(() => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth/token")) {
      if (mode === "network_failure") throw new Error("ambiguous connection reset");
      if (mode === "token_500") return Response.json({ error: "server_error" }, { status: 500 });
      if (mode === "missing_refresh") {
        return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
      }
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope:
          mode === "reduced_scope"
            ? "user:inference"
            : CLAUDE_SUBSCRIPTION_OAUTH.scopes,
      });
    }
    if (url.endsWith("/api/oauth/usage")) {
      return Response.json({ five_hour: { utilization: 18, resets_at: null } });
    }
    if (url.endsWith("/api/oauth/profile")) {
      return Response.json({
        account: { uuid: profileAccountId, email: "oauth@example.com", full_name: "OAuth Account" },
        organization: { organization_type: "claude_pro" },
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
});

beforeEach(async () => {
  mode = "success";
  profileAccountId = "acct-oauth";
  calls = [];
  delete process.env.APP_PASSWORD;
  await saveAccounts("default", []);
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

function request(overrides: Record<string, unknown> = {}, headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/connect/oauth", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify({ code: CODE, state: STATE, verifier: VERIFIER, ...overrides }),
  });
}

test("OAuth connection exchanges once, verifies both APIs, and persists before a token-free 200", async () => {
  const before = Date.now();
  const response = await POST(request());
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: true,
    id: "acct-oauth",
    email: "oauth@example.com",
    plan: "Pro",
    label: "OAuth Account",
    alreadyConnected: false,
  });
  const serialized = JSON.stringify(body);
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CODE, VERIFIER]) {
    assert.equal(serialized.includes(secret), false);
  }

  const tokenCalls = calls.filter((call) => call.url.endsWith("/v1/oauth/token"));
  assert.equal(tokenCalls.length, 1);
  assert.deepEqual(JSON.parse(String(tokenCalls[0].init?.body)), {
    grant_type: "authorization_code",
    code: CODE,
    state: STATE,
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect_uri: "https://platform.claude.com/oauth/code/callback",
    code_verifier: VERIFIER,
  });
  const tokenHeaders = new Headers(tokenCalls[0].init?.headers);
  assert.equal(tokenHeaders.get("content-type"), "application/json");
  assert.equal(tokenHeaders.get("anthropic-beta"), null);
  assert.equal(tokenHeaders.get("user-agent"), null);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/oauth/usage")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/oauth/profile")).length, 1);

  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "acct-oauth");
  assert.equal(stored[0].credentialKind, "managed");
  assert.equal(stored[0].tokens.accessToken, ACCESS_TOKEN);
  assert.equal(stored[0].tokens.refreshToken, REFRESH_TOKEN);
  assert.ok(stored[0].tokens.expiresAt >= before + 3_599_000);
});

test("OAuth storage failures return a correlation id without reflecting or logging exception secrets", async () => {
  const secret = "fake-oauth-storage-secret";
  const poisonPath = path.join(dataDir, secret);
  const previousDataDir = process.env.VAULT_DATA_DIR;
  const originalConsoleError = console.error;
  const captured: unknown[][] = [];
  await fs.writeFile(poisonPath, "not a directory");
  process.env.VAULT_DATA_DIR = poisonPath;
  console.error = (...args: unknown[]) => captured.push(args);

  try {
    const response = await POST(request());
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; errorId: string };
    assert.equal(
      body.error,
      "Claude was verified, but its encrypted credential could not be saved. Start the connection again.",
    );
    assert.match(body.errorId, /^err_[a-f0-9]{12}$/);
    assert.deepEqual(captured, [
      [
        {
          errorId: body.errorId,
          scope: "connect.oauth.save",
          errorClass: "Error",
          code: "ENOTDIR",
        },
      ],
    ]);
    const serialized = JSON.stringify({ body, captured });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("message"), false);
    assert.equal(serialized.includes("cause"), false);
  } finally {
    console.error = originalConsoleError;
    if (previousDataDir === undefined) delete process.env.VAULT_DATA_DIR;
    else process.env.VAULT_DATA_DIR = previousDataDir;
    await fs.rm(poisonPath, { force: true });
  }
});

test("authorization code is never retried or sent to a fallback after 5xx or transport ambiguity", async () => {
  for (const failureMode of ["token_500", "network_failure"] as const) {
    mode = failureMode;
    calls = [];
    const response = await POST(request());
    assert.equal(response.status, 502);
    assert.equal(calls.filter((call) => call.url.endsWith("/v1/oauth/token")).length, 1);
    assert.equal(calls.some((call) => call.url.includes("console.anthropic.com")), false);
    assert.deepEqual(await loadAccounts("default"), []);
  }
});

test("an authorization response without a refresh token is never persisted", async () => {
  mode = "missing_refresh";
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/oauth/token")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/api/oauth/usage")), false);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("a reduced-scope credential is rejected before verification or persistence", async () => {
  mode = "reduced_scope";
  const response = await POST(request());
  assert.equal(response.status, 400);
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/oauth/token")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/api/oauth/usage")), false);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("targeted reconnect rejects another verified account without changing the vault", async () => {
  const existing = {
    id: "acct-target",
    email: "target@example.com",
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "rotating" as const,
    tokens: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1_800_000_000_000 },
  };
  await saveAccounts("default", [existing]);
  profileAccountId = "acct-different";
  const response = await POST(request({ expectedAccountId: existing.id }));
  assert.equal(response.status, 409);
  assert.deepEqual(await loadAccounts("default"), [existing]);
});

test("verified reconnect dedupes by account id and retains the user's metadata", async () => {
  const existing = {
    id: "acct-oauth",
    email: "old@example.com",
    label: "My subscription",
    plan: "Claude",
    addedAt: 1_700_000_000_000,
    credentialKind: "rotating" as const,
    tokens: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1_800_000_000_000 },
  };
  await saveAccounts("default", [existing]);
  const response = await POST(request({ expectedAccountId: existing.id }));
  assert.equal(response.status, 200);
  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, existing.id);
  assert.equal(stored[0].label, existing.label);
  assert.equal(stored[0].addedAt, existing.addedAt);
  assert.equal(stored[0].credentialKind, "managed");
  assert.equal(stored[0].tokens.accessToken, ACCESS_TOKEN);
  assert.equal(stored[0].tokens.refreshToken, REFRESH_TOKEN);
});

test("route rejects unauthenticated, cross-origin, primitive, oversized, and malformed input before exchange", async () => {
  process.env.APP_PASSWORD = "configured-password";
  const unauthenticated = await POST(request());
  assert.equal(unauthenticated.status, 401);
  delete process.env.APP_PASSWORD;

  const crossOrigin = await POST(request({}, { Origin: "https://attacker.example" }));
  assert.equal(crossOrigin.status, 403);
  const primitive = await POST(
    new Request("http://localhost/api/connect/oauth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    }),
  );
  assert.equal(primitive.status, 400);
  assert.equal((await POST(request({ verifier: "short" }))).status, 400);
  assert.equal((await POST(request({ unexpected: true }))).status, 400);
  const oversized = await POST(
    new Request("http://localhost/api/connect/oauth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "99999" },
      body: "{}",
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, 0);
});
