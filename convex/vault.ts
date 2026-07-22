import { query, mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

// Legacy rollout proof used by app versions that predate tenant-scoped proof rows. New writers pass
// an `accounts-key-proof[::<tenant>]` key so independently readable historical tenant generations
// can retain their exact key while still rejecting divergent writers for that tenant.
const KEY_PROOF_STORAGE_KEY = "__hmc_vault_key_proof_v1__";
const KEY_PROOF_MISMATCH_ERROR = "Vault encryption key mismatch";
const KEY_PROOF_REQUIRED_ERROR = "Vault encryption key proof is required";
const ACCOUNT_KEY = "accounts";
const ACCOUNT_KEY_PREFIX = "accounts::";
const ACCOUNT_BACKUP_KEY = "accounts-last-good";
const ACCOUNT_BACKUP_KEY_PREFIX = "accounts-last-good::";
const ACCOUNT_PROOF_KEY = "accounts-key-proof";
const ACCOUNT_PROOF_KEY_PREFIX = "accounts-key-proof::";

// These functions are reachable by anyone who knows the deployment URL, so they're gated
// by a shared secret that only the app's server knows (VAULT_ACCESS_SECRET, set in this
// Convex deployment's env). The stored blob is already encrypted by the app, but this stops
// anyone from reading the ciphertext or wiping the vault.
//
// `key` is the storage key the app computes in lib/app-config. Self-hosted requests retain the
// historical bare `accounts` key; the broader validator preserves readability of imported rows.
function assertSecret(secret: string) {
  const expected = process.env.VAULT_ACCESS_SECRET?.trim();
  if (!expected || !secret.trim() || secret.trim() !== expected) {
    throw new Error("Unauthorized");
  }
}

async function rowForKey(ctx: MutationCtx, key: string) {
  return await ctx.db
    .query("vault")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function upsertData(ctx: MutationCtx, key: string, data: string): Promise<void> {
  const row = await rowForKey(ctx, key);
  if (row) await ctx.db.patch(row._id, { data });
  else await ctx.db.insert("vault", { key, data });
}

function assertOrdinaryStorageKey(key: string): void {
  if (!key || key === KEY_PROOF_STORAGE_KEY) {
    throw new Error("Invalid or reserved vault storage key");
  }
}

function isPrimaryAccountKey(key: string): boolean {
  return key === ACCOUNT_KEY || key.startsWith(ACCOUNT_KEY_PREFIX);
}

function isAccountBackupKey(key: string): boolean {
  return key === ACCOUNT_BACKUP_KEY || key.startsWith(ACCOUNT_BACKUP_KEY_PREFIX);
}

function isAccountProofKey(key: string): boolean {
  return key === ACCOUNT_PROOF_KEY || key.startsWith(ACCOUNT_PROOF_KEY_PREFIX);
}

function accountKeySuffix(key: string): string | null {
  if (key === ACCOUNT_KEY) return "";
  if (key.startsWith(ACCOUNT_KEY_PREFIX)) return key.slice(ACCOUNT_KEY.length);
  return null;
}

function proofKeyForRecoveryKey(key: string): string | null {
  if (!key.startsWith("token-recovery:")) return null;
  const tenantSeparator = key.lastIndexOf("::");
  return tenantSeparator >= "token-recovery:".length
    ? `${ACCOUNT_PROOF_KEY}${key.slice(tenantSeparator)}`
    : ACCOUNT_PROOF_KEY;
}

async function assertLegacyWriterNotFenced(
  ctx: MutationCtx,
  tenantProofKey: string,
  message: string,
  includeLegacyGlobalProof = true,
): Promise<void> {
  // The global row fences immediately-previous rollout clients in this production deployment; the
  // tenant row keeps them fenced after a clean install moves straight to scoped proofs. New clients
  // use proofKey/compareAndSetAuxiliary and never enter this compatibility path.
  const [tenantProof, legacyGlobalProof] = await Promise.all([
    rowForKey(ctx, tenantProofKey),
    includeLegacyGlobalProof ? rowForKey(ctx, KEY_PROOF_STORAGE_KEY) : Promise.resolve(null),
  ]);
  if (tenantProof || legacyGlobalProof) throw new Error(message);
}

function assertGenericSetKey(key: string): void {
  assertOrdinaryStorageKey(key);
  if (isPrimaryAccountKey(key) || isAccountBackupKey(key) || isAccountProofKey(key)) {
    throw new Error("Primary, backup, and proof account vault rows require a guarded mutation");
  }
}

function assertBackupKey(key: string, backupKey: string): void {
  assertOrdinaryStorageKey(key);
  assertOrdinaryStorageKey(backupKey);
  if (key === backupKey) throw new Error("Vault backup key must differ from the primary key");
}

// Called only after the mutation has established that its CAS expectations still match. Convex
// mutations are transactional, so either the proof check plus every later ciphertext write commits,
// or none of them do. Legacy callers omit keyProof and retain the historical behavior during a
// staggered functions-first deployment.
async function assertOrInitializeKeyProof(
  ctx: MutationCtx,
  proofStorageKey: string,
  keyProof: string | undefined,
): Promise<void> {
  const proof = await rowForKey(ctx, proofStorageKey);
  // Functions are deployed before the app during rollout. Legacy callers may omit the optional
  // proof only until the first guarded writer establishes the deployment-wide value; afterward an
  // omitted proof is an unsafe bypass and must fail without touching ciphertext.
  if (keyProof === undefined) {
    if (proof) throw new Error(KEY_PROOF_REQUIRED_ERROR);
    return;
  }
  if (!keyProof) throw new Error("Vault encryption key proof is invalid");

  if (proof && proof.data !== keyProof) throw new Error(KEY_PROOF_MISMATCH_ERROR);
  if (!proof) await ctx.db.insert("vault", { key: proofStorageKey, data: keyProof });
}

export const get = query({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("vault")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    return row?.data ?? null;
  },
});

export const set = mutation({
  args: { secret: v.string(), key: v.string(), data: v.string() },
  handler: async (ctx, { secret, key, data }) => {
    assertSecret(secret);
    // The proof row can only be initialized/checked by the guarded mutations below. Keeping it out
    // of the generic setter prevents an accidental secret-gated write from disabling that guard.
    assertGenericSetKey(key);
    const recoveryProofKey = proofKeyForRecoveryKey(key);
    if (recoveryProofKey) {
      await assertLegacyWriterNotFenced(
        ctx,
        recoveryProofKey,
        "Rotated-token recovery records require exact compare-and-set",
        false,
      );
    }
    await upsertData(ctx, key, data);
    return null;
  },
});

// Exact compare-and-set for encrypted auxiliary records such as the single-use refresh-token
// recovery journal. A stale worker may clear only the ciphertext generation it actually wrote/read;
// it can never tombstone a newer worker's replacement token.
export const compareAndSetAuxiliary = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    expected: v.union(v.string(), v.null()),
    data: v.string(),
  },
  handler: async (ctx, { secret, key, expected, data }) => {
    assertSecret(secret);
    assertGenericSetKey(key);
    const row = await rowForKey(ctx, key);
    if ((row?.data ?? null) !== expected) return false;
    if (row) await ctx.db.patch(row._id, { data });
    else await ctx.db.insert("vault", { key, data });
    return true;
  },
});

// Atomic compare-and-set for whole-vault read/modify/write operations. Convex retries conflicting
// mutations transactionally, so two app instances that read the same ciphertext cannot both replace
// it: exactly one wins and the other reloads/merges through lib/vault.ts.
export const compareAndSet = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    expected: v.union(v.string(), v.null()),
    data: v.string(),
    // Optional for a safe functions-first rollout: old app instances can keep using the historical
    // four-argument CAS while new instances atomically preserve the previous readable ciphertext.
    backupKey: v.optional(v.string()),
    // New clients scope the proof to the same tenant as the primary row. Legacy clients omit this
    // and continue to use the deployment-global rollout proof until the matching app is deployed.
    proofKey: v.optional(v.string()),
    // A non-secret key fingerprint. When supplied, every guarded writer for this tenant must match
    // the proof established by its first successful guarded mutation.
    keyProof: v.optional(v.string()),
  },
  handler: async (ctx, { secret, key, expected, data, backupKey, proofKey, keyProof }) => {
    assertSecret(secret);
    assertOrdinaryStorageKey(key);
    if (backupKey !== undefined) assertBackupKey(key, backupKey);
    if (proofKey !== undefined) {
      const suffix = accountKeySuffix(key);
      if (suffix === null || proofKey !== `${ACCOUNT_PROOF_KEY}${suffix}`) {
        throw new Error("Vault encryption proof key does not match the primary account key");
      }
      if (backupKey !== `${ACCOUNT_BACKUP_KEY}${suffix}`) {
        throw new Error("Vault backup key does not match the primary account key");
      }
    } else {
      const suffix = accountKeySuffix(key);
      if (suffix !== null) {
        await assertLegacyWriterNotFenced(
          ctx,
          `${ACCOUNT_PROOF_KEY}${suffix}`,
          KEY_PROOF_REQUIRED_ERROR,
        );
      }
    }

    const row = await rowForKey(ctx, key);
    if ((row?.data ?? null) !== expected) return false;

    // Nothing below this point may run for a failed CAS: a stale contender must neither establish a
    // key proof nor replace the last-known-good backup. A thrown proof mismatch rolls back the whole
    // Convex transaction before either ciphertext row changes.
    await assertOrInitializeKeyProof(ctx, proofKey ?? KEY_PROOF_STORAGE_KEY, keyProof);
    // `data` was produced from a fully parsed/validated logical vault. Keep the recoverable copy on
    // this newly committed generation, not the predecessor (which may contain a spent or deleted
    // credential). The Convex mutation commits main + backup atomically.
    if (backupKey !== undefined) await upsertData(ctx, backupKey, data);

    if (row) await ctx.db.patch(row._id, { data });
    else await ctx.db.insert("vault", { key, data });
    return true;
  },
});

// Restore a previously validated last-known-good ciphertext without ever rotating the backup. Both
// byte-for-byte expectations fence the operation: if another process repaired/updated either row
// after the app read it, this returns false and lets the app reload instead of clobbering that work.
export const restoreBackup = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    backupKey: v.string(),
    expectedMain: v.union(v.string(), v.null()),
    expectedBackup: v.string(),
    keyProof: v.string(),
    proofKey: v.optional(v.string()),
  },
  handler: async (ctx, { secret, key, backupKey, expectedMain, expectedBackup, keyProof, proofKey }) => {
    assertSecret(secret);
    assertBackupKey(key, backupKey);
    if (proofKey !== undefined) {
      const suffix = accountKeySuffix(key);
      if (
        suffix === null ||
        backupKey !== `${ACCOUNT_BACKUP_KEY}${suffix}` ||
        proofKey !== `${ACCOUNT_PROOF_KEY}${suffix}`
      ) {
        throw new Error("Vault recovery keys do not match the primary account key");
      }
    } else {
      const suffix = accountKeySuffix(key);
      if (suffix !== null) {
        await assertLegacyWriterNotFenced(
          ctx,
          `${ACCOUNT_PROOF_KEY}${suffix}`,
          KEY_PROOF_REQUIRED_ERROR,
        );
      }
    }

    const main = await rowForKey(ctx, key);
    if ((main?.data ?? null) !== expectedMain) return false;
    const backup = await rowForKey(ctx, backupKey);
    if (backup?.data !== expectedBackup) return false;

    // A legacy deployment may have a readable backup but no proof row yet; initialize it as part of
    // this exact guarded restore. A different established proof aborts transactionally with no write.
    await assertOrInitializeKeyProof(ctx, proofKey ?? KEY_PROOF_STORAGE_KEY, keyProof);
    if (main) await ctx.db.patch(main._id, { data: expectedBackup });
    else await ctx.db.insert("vault", { key, data: expectedBackup });
    return true;
  },
});

// Primary account-vault keys only. The optional pagination argument keeps the functions-first
// rollout source-compatible with the previous app, whose no-argument call receives a bounded array.
// New app instances page the namespaced index range and never materialize ciphertext, backup, proof,
// or token-recovery rows. The bare `accounts` key is prepended only to the first page.
