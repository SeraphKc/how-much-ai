import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoredAccount } from "./types.ts";

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

const ENV_KEYS = [
  "APP_PASSWORD",
  "VAULT_ENCRYPTION_SECRET",
  "VAULT_DATA_DIR",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-vault-recovery-test-"));
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "vault-recovery-test-secret-with-enough-entropy";

const {
  loadAccounts,
  recoverUnreadableLocalVault,
  saveAccounts,
  VAULT_RECOVERY_CONFIRMATION,
} = await import("./vault.ts");
const { POST: recoverPost } = await import("../app/api/vault/recover/route.ts");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  moduleHooks.deregister();
});

beforeEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  delete process.env.APP_PASSWORD;
  delete process.env.CONVEX_URL;
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.VAULT_ACCESS_SECRET;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.VERCEL;
  process.env.VAULT_DATA_DIR = dataDir;
  process.env.VAULT_ENCRYPTION_SECRET = "vault-recovery-test-secret-with-enough-entropy";
});

function request(body: string): Request {
  return new Request("http://localhost/api/vault/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function account(): StoredAccount {
  return {
    id: "readable",
    email: "readable@example.com",
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "long_lived",
    tokens: { accessToken: "sk-ant-oat01-readable", refreshToken: null, expiresAt: 1_800_000_000_000 },
  };
}

test("recovery requires authentication when the local app is password protected", async () => {
  process.env.APP_PASSWORD = "local-login-password";
  const response = await recoverPost(request(JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION })));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Not signed in" });
});

test("recovery requires the exact explicit confirmation object and leaves the vault untouched", async () => {
  const source = path.join(dataDir, "vault.enc");
  const corrupt = "unreadable-vault-ciphertext";
  await fs.writeFile(source, corrupt, { mode: 0o600 });

  for (const body of [
    "null",
    "{}",
    JSON.stringify({ confirmation: true }),
    JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION.toLowerCase() }),
    JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION, extra: true }),
  ]) {
    const response = await recoverPost(request(body));
    assert.equal(response.status, 400);
    assert.equal(await fs.readFile(source, "utf8"), corrupt);
  }
  assert.deepEqual((await fs.readdir(dataDir)).filter((name) => name.startsWith("vault-unreadable-")), []);
});

test("recovery atomically archives an unreadable local vault, preserves vault.key, and starts empty", async () => {
  const source = path.join(dataDir, "vault.enc");
  const keyFile = path.join(dataDir, "vault.key");
  const corrupt = "v2:not-the-old-key:not-a-tag:not-ciphertext";
  const generatedKey = "generated-local-key-that-must-not-be-replaced-1234567890";
  await fs.chmod(dataDir, 0o755);
  await fs.writeFile(source, corrupt, { mode: 0o644 });
  await fs.writeFile(keyFile, generatedKey, { mode: 0o600 });

  const response = await recoverPost(
    request(JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION })),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as { ok: boolean; archive: string };
  assert.equal(result.ok, true);
  assert.match(result.archive, /^vault-unreadable-\d{8}T\d{9}Z-[a-f0-9]{12}-[a-f0-9]{16}\.enc$/);
  assert.equal(path.basename(result.archive), result.archive, "the API returns a label, never a filesystem path");
  await assert.rejects(() => fs.lstat(source), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await fs.readFile(path.join(dataDir, result.archive), "utf8"), corrupt);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, result.archive))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(keyFile, "utf8"), generatedKey);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("recovery refuses to discard a readable last-known-good backup and lets normal loading restore it", async () => {
  const source = path.join(dataDir, "vault.enc");
  const backup = `${source}.last-good`;
  const first = account();
  const second = { ...account(), id: "second", email: "second@example.com" };
  await saveAccounts("default", [first]);
  await saveAccounts("default", [first, second]);
  const readableBackup = await fs.readFile(backup, "utf8");
  await fs.writeFile(source, "unreadable-main-with-readable-backup", { mode: 0o600 });

  await assert.rejects(
    () => recoverUnreadableLocalVault("default"),
    /readable last-known-good backup.*reload/i,
  );
  assert.equal(await fs.readFile(source, "utf8"), "unreadable-main-with-readable-backup");
  assert.equal(await fs.readFile(backup, "utf8"), readableBackup);
  assert.deepEqual(await loadAccounts("default"), [first, second]);
});

test("recovery archives both unreadable generations so the stale backup cannot resurrect", async () => {
  const source = path.join(dataDir, "vault.enc");
  const backup = `${source}.last-good`;
  const corruptMain = "unreadable-main-generation";
  const corruptBackup = "unreadable-backup-generation";
  await fs.writeFile(source, corruptMain, { mode: 0o600 });
  await fs.writeFile(backup, corruptBackup, { mode: 0o600 });

  const response = await recoverPost(
    request(JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION })),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as { ok: boolean; archive: string; backupArchive?: string };
  assert.equal(result.ok, true);
  assert.match(result.archive, /^vault-unreadable-/);
  assert.match(result.backupArchive ?? "", /^vault-unreadable-backup-/);
  await assert.rejects(() => fs.lstat(source), { code: "ENOENT" });
  await assert.rejects(() => fs.lstat(backup), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(dataDir, result.archive), "utf8"), corruptMain);
  assert.equal(await fs.readFile(path.join(dataDir, result.backupArchive!), "utf8"), corruptBackup);
  assert.deepEqual(await loadAccounts("default"), []);
});

test("recovery refuses missing, readable, and non-file local vault paths without changing them", async () => {
  await assert.rejects(() => recoverUnreadableLocalVault("default"), /no local saved-account vault/i);

  await saveAccounts("default", [account()]);
  const readableRaw = await fs.readFile(path.join(dataDir, "vault.enc"), "utf8");
  await assert.rejects(() => recoverUnreadableLocalVault("default"), /vault is readable/i);
  assert.equal(await fs.readFile(path.join(dataDir, "vault.enc"), "utf8"), readableRaw);
  assert.deepEqual(await loadAccounts("default"), [account()]);

  await fs.rm(path.join(dataDir, "vault.enc"));
  await fs.mkdir(path.join(dataDir, "vault.enc"));
  await assert.rejects(() => recoverUnreadableLocalVault("default"), /not a regular file/i);
  assert.equal((await fs.lstat(path.join(dataDir, "vault.enc"))).isDirectory(), true);
});

test("remote vault backends reject local recovery with an actionable error and no storage call", async () => {
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "redis-token";
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected remote storage call");
  };
  try {
    const response = await recoverPost(
      request(JSON.stringify({ confirmation: VAULT_RECOVERY_CONFIRMATION })),
    );
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /only available for local file storage.*redis/i);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
