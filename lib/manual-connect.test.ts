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
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-manual-connect-"));

delete process.env.APP_PASSWORD;
delete process.env.CONVEX_URL;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.VAULT_DATA_DIR = dataDir;

const { POST } = await import("../app/api/connect/manual/route.ts");
const { dedicatedTokenAccountId } = await import("./connect-account.ts");
const { loadAccounts, saveAccounts } = await import("./vault.ts");

let profileAvailable = true;
let usageRequiresProfile = false;

before(() => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/usage")) {
      if (usageRequiresProfile) {
        return Response.json(
          {
            type: "error",
            error: {
              type: "permission_error",
              message: "OAuth token does not meet scope requirement user:profile",
              details: { error_visibility: "user_facing" },
            },
          },
          { status: 403 },
        );
      }
      return Response.json({ five_hour: { utilization: 12, resets_at: null } });
    }
    if (url.endsWith("/api/oauth/profile")) {
      if (!profileAvailable) {
        return Response.json(
          {
            error: {
              type: "permission_error",
              message: "Missing permission user:profile",
              details: { permission: "user:profile" },
            },
          },
          { status: 403 },
        );
      }
      return Response.json({
        account: { uuid: "acct-durable", email: "durable@example.com", full_name: "Durable Token" },
        organization: { organization_type: "claude_pro" },
      });
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };
});

beforeEach(() => {
  profileAvailable = true;
  usageRequiresProfile = false;
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

test("manual setup-token connection is durable before success is returned", async () => {
  await saveAccounts("default", []);
  const token = { accessToken: "sk-ant-oat01-durable", refreshToken: null, expiresAt: Date.now() + 365 * 86_400_000 };
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: token }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; id: string };
  assert.equal(body.ok, true);
  assert.equal(body.id, "acct-durable");
  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].credentialKind, "long_lived");
  assert.deepEqual(stored[0].tokens, token);
});

test("a verified manual account returns a safe incident reference when encrypted saving fails", async () => {
  const poisonPath = path.join(dataDir, "manual-save-not-a-directory");
  await fs.writeFile(poisonPath, "not a directory");
  const previousDataDir = process.env.VAULT_DATA_DIR;
  const originalConsoleError = console.error;
  const captured: unknown[][] = [];
  process.env.VAULT_DATA_DIR = poisonPath;
  console.error = (...args: unknown[]) => captured.push(args);

  try {
    const response = await POST(
      new Request("http://localhost/api/connect/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: {
            accessToken: "sk-ant-oat01-verified-but-unsaved",
            refreshToken: null,
            expiresAt: Date.now() + 365 * 86_400_000,
          },
        }),
      }),
    );
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; errorId: string };
    assert.equal(
      body.error,
      "The account was verified, but its encrypted credential could not be saved. Try again.",
    );
    assert.match(body.errorId, /^err_[a-f0-9]{12}$/);
    assert.deepEqual(captured, [
      [
        {
          errorId: body.errorId,
          scope: "connect.manual.save",
          errorClass: "Error",
          code: "ENOTDIR",
        },
      ],
    ]);
    assert.equal(JSON.stringify({ body, captured }).includes("sk-ant-oat01-verified-but-unsaved"), false);
  } finally {
    console.error = originalConsoleError;
    process.env.VAULT_DATA_DIR = previousDataDir;
    await fs.rm(poisonPath, { force: true });
  }
});

test("a verified rotating credential with missing expiry gets a conservative access lifetime", async () => {
  await saveAccounts("default", []);
  const before = Date.now();
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokens: { accessToken: "sk-ant-oat01-legacy", refreshToken: "single-use-r0", expiresAt: 0 },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const [stored] = await loadAccounts("default");
  assert.equal(stored.credentialKind, "rotating");
  assert.equal(stored.tokens.refreshToken, "single-use-r0");
  assert.ok(stored.tokens.expiresAt >= before + 7 * 60 * 60_000);
});

test("manual reconnect rejects a different verified account without changing the vault", async () => {
  await saveAccounts("default", []);
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedAccountId: "another-account",
        tokens: { accessToken: "sk-ant-oat01-other", refreshToken: null, expiresAt: Date.now() + 1000 },
      }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("manual connection rejects malformed credential input before upstream work", async () => {
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: { accessToken: 42 } }),
    }),
  );
  assert.equal(response.status, 400);
});

test("a dedicated setup token is saved with an honest stable local identity when profile access is forbidden", async () => {
  profileAvailable = false;
  await saveAccounts("default", []);
  const token = {
    accessToken: "sk-ant-oat01-profileless-dedicated",
    refreshToken: null,
    expiresAt: Date.now() + 365 * 86_400_000,
  };
  const connect = () =>
    POST(
      new Request("http://localhost/api/connect/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: token }),
      }),
    );

  const first = await connect();
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    ok: boolean;
    id: string;
    email: string;
    plan: string;
    alreadyConnected: boolean;
    profile: unknown;
  };
  assert.equal(firstBody.ok, true);
  assert.match(firstBody.id, /^setup-token-[a-f0-9]{64}$/);
  assert.equal(firstBody.id.includes(token.accessToken), false);
  assert.equal(firstBody.email, "Email unavailable");
  assert.equal(firstBody.plan, "Claude");
  assert.equal(firstBody.alreadyConnected, false);
  assert.equal(firstBody.profile, null);
  assert.equal(JSON.stringify(firstBody).includes(token.accessToken), false);

  const second = await connect();
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { id: string; alreadyConnected: boolean };
  assert.equal(secondBody.id, firstBody.id);
  assert.equal(secondBody.alreadyConnected, true);

  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, firstBody.id);
  assert.equal(stored[0].email, "Email unavailable");
  assert.equal(stored[0].label, "Dedicated monitor token");
  assert.equal(stored[0].plan, "Claude");
  assert.equal(stored[0].credentialKind, "long_lived");
  assert.deepEqual(stored[0].tokens, token);
});

test("a rotating credential is never saved when profile identity is unavailable", async () => {
  profileAvailable = false;
  await saveAccounts("default", []);
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokens: {
          accessToken: "sk-ant-oat01-profileless-rotating",
          refreshToken: "single-use-profileless-r0",
          expiresAt: Date.now() + 60_000,
        },
      }),
    }),
  );

  assert.notEqual(response.status, 200);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("an inference-only setup token gets an actionable error when usage requires profile scope", async () => {
  usageRequiresProfile = true;
  await saveAccounts("default", []);
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokens: {
          accessToken: "sk-ant-oat01-inference-only",
          refreshToken: null,
          expiresAt: Date.now() + 365 * 86_400_000,
        },
      }),
    }),
  );
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? "", /setup-token.*inference-only.*private app login/i);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("a profile-less dedicated token cannot be attached to a different selected long-lived identity", async () => {
  profileAvailable = false;
  const existing = {
    id: "acct-existing-dedicated",
    email: "known@example.com",
    fullName: "Known Account",
    label: "Primary workspace",
    plan: "Max 5×",
    addedAt: 1_700_000_000_000,
    credentialKind: "long_lived" as const,
    tokens: {
      accessToken: "sk-ant-oat01-old-dedicated",
      refreshToken: null,
      expiresAt: 1_800_000_000_000,
    },
  };
  const replacement = {
    accessToken: "sk-ant-oat01-new-profileless-dedicated",
    refreshToken: null,
    expiresAt: Date.now() + 365 * 86_400_000,
  };
  const syntheticDuplicate = {
    id: dedicatedTokenAccountId(replacement.accessToken),
    email: "Email unavailable",
    label: "Dedicated monitor token",
    plan: "Claude",
    addedAt: 1_710_000_000_000,
    credentialKind: "long_lived" as const,
    tokens: replacement,
  };
  await saveAccounts("default", [existing, syntheticDuplicate]);

  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedAccountId: existing.id, tokens: replacement }),
    }),
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? "", /cannot be proven to belong to the selected account/i);
  assert.equal(JSON.stringify(body).includes(replacement.accessToken), false);
  assert.deepEqual(await loadAccounts("default"), [existing, syntheticDuplicate]);
});

test("a profile-less dedicated reconnect can update its own token-hash identity", async () => {
  profileAvailable = false;
  const token = {
    accessToken: "sk-ant-oat01-same-profileless-dedicated",
    refreshToken: null,
    expiresAt: Date.now() + 365 * 86_400_000,
  };
  const id = dedicatedTokenAccountId(token.accessToken);
  const existing = {
    id,
    email: "Email unavailable",
    label: "Dedicated monitor token",
    plan: "Claude",
    addedAt: 1_710_000_000_000,
    credentialKind: "long_lived" as const,
    tokens: { ...token, expiresAt: 1_800_000_000_000 },
  };
  await saveAccounts("default", [existing]);

  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedAccountId: id, tokens: token }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { id: string; alreadyConnected: boolean };
  assert.equal(body.id, id);
  assert.equal(body.alreadyConnected, true);
  assert.deepEqual(await loadAccounts("default"), [{ ...existing, tokens: token }]);
});

test("a profile-less token cannot replace a selected rotating account", async () => {
  profileAvailable = false;
  const rotating = {
    id: "acct-shared-cli",
    email: "shared@example.com",
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "rotating" as const,
    tokens: {
      accessToken: "sk-ant-oat01-shared-old",
      refreshToken: "single-use-shared-r0",
      expiresAt: 1_800_000_000_000,
    },
  };
  await saveAccounts("default", [rotating]);
  const response = await POST(
    new Request("http://localhost/api/connect/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedAccountId: rotating.id,
        tokens: {
          accessToken: "sk-ant-oat01-new-profileless-dedicated",
          refreshToken: null,
          expiresAt: Date.now() + 365 * 86_400_000,
        },
      }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await loadAccounts("default"), [rotating]);
});
