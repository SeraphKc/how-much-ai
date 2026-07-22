// Cross-process locking for the local-file self-hosted backend.
//
// `mkdir` is the portable atomic primitive: exactly one process can create a lock directory. The
// owner record contains a random fencing token plus this host's pid. A waiter may reap a lock only
// after proving that its SAME-HOST owner process no longer exists; a lock from another hostname is
// never guessed stale. That deliberately fails safe on shared/NFS filesystems instead of letting two
// machines spend the same single-use refresh token.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

type LockIntentKind = "acquire" | "reap";

interface LockIntent {
  path: string;
}

export interface LocalFileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  // A process can die after mkdir and before writing owner.json. Wait this long before reaping that
  // provably ownerless directory. Normal acquisition writes owner.json immediately.
  orphanGraceMs?: number;
}

export class LocalFileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number, owner: LockOwner | null) {
    const detail = owner
      ? `owner pid ${owner.pid} on ${owner.hostname}`
      : "owner metadata unavailable";
    super(`Timed out after ${timeoutMs}ms waiting for local lock ${lockPath} (${detail}).`);
    this.name = "LocalFileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

function dataDir(): string {
  return process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
}

function lockName(scope: string, parts: string[]): string {
  const digest = crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return path.join(dataDir(), ".locks", `${scope}-${digest}.lock`);
}

export function localVaultMutationLockPath(userId: string): string {
  return lockName("vault", [userId]);
}

export function localUsageRefreshLockPath(userId: string, accountId: string): string {
  return lockName("usage", [userId, accountId]);
}

function ownerFile(lockPath: string): string {
  return path.join(lockPath, "owner.json");
}

function intentPrefix(lockPath: string, kind: LockIntentKind): string {
  return `${path.basename(lockPath)}.${kind}-`;
}

function intentFile(lockPath: string, kind: LockIntentKind, token: string): string {
  return path.join(path.dirname(lockPath), `${intentPrefix(lockPath, kind)}${token}.json`);
}

function validOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<LockOwner>;
  return (
    owner.version === 1 &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.hostname === "string" &&
    owner.hostname.length > 0 &&
    typeof owner.createdAt === "number" &&
    Number.isFinite(owner.createdAt)
  );
}

async function readOwnerRecord(file: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return validOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  return readOwnerRecord(ownerFile(lockPath));
}

function newOwner(token = crypto.randomUUID()): LockOwner {
  return {
    version: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a process exists but this user may not signal it. Only ESRCH proves absence.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeIntent(file: string): Promise<void> {
  try {
    // Intent names contain a never-reused random token. Unlike the canonical lock path, an intent
    // can therefore be removed by pathname without risking deletion of a replacement generation.
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createIntent(lockPath: string, kind: LockIntentKind): Promise<LockIntent> {
  const owner = newOwner();
  const file = intentFile(lockPath, kind, owner.token);
  await fs.writeFile(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  return { path: file };
}

async function activeIntents(
  lockPath: string,
  kind: LockIntentKind,
  orphanGraceMs: number,
): Promise<string[]> {
  const dir = path.dirname(lockPath);
  const prefix = intentPrefix(lockPath, kind);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const active: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing unsafe local lock intent path that is not a regular file: ${file}`);
    }

    const owner = await readOwnerRecord(file);
    if (!owner) {
      // A process can die between the exclusive create and its complete write becoming observable.
      // The unique pathname is never reused, so removing this exact old orphan cannot hit a successor.
      if (Date.now() - info.mtimeMs < orphanGraceMs) {
        active.push(file);
      } else {
        await removeIntent(file);
      }
      continue;
    }
    if (owner.hostname !== os.hostname() || processIsAlive(owner.pid)) {
      active.push(file);
      continue;
    }
    await removeIntent(file);
  }
  return active;
}

async function quarantineAndRemove(lockPath: string): Promise<boolean> {
  const quarantine = `${lockPath}.reaped-${process.pid}-${crypto.randomUUID()}`;
  try {
    // Callers publish either an acquisition intent for a not-yet-owned directory or a reap intent
    // after all acquisition intents drain. That fence keeps the canonical pathname on this exact
    // generation until the rename; deletion then happens outside the canonical namespace.
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

async function reapDeadSameHostOwner(lockPath: string, orphanGraceMs: number): Promise<boolean> {
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe local lock path that is not a real directory: ${lockPath}`);
  }

  const owner = await readOwner(lockPath);
  if (!owner) {
    if (Date.now() - info.mtimeMs < orphanGraceMs) return false;
    return quarantineAndRemove(lockPath);
  }
  if (owner.hostname !== os.hostname()) return false;
  if (processIsAlive(owner.pid)) return false;
  return quarantineAndRemove(lockPath);
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (!owner || owner.token !== token) return;
  // Rename first, while ownership still matches, then delete outside the canonical namespace. This
  // prevents a delayed finally block from deleting a replacement owner's lock.
  const released = `${lockPath}.released-${process.pid}-${token}`;
  try {
    await fs.rename(lockPath, released);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A storage fault can make rename fail while deletion still works. No other same-host waiter may
    // reap a lock whose owner pid is alive, so a final token check makes direct removal safe here.
    const stillOwned = await readOwner(lockPath);
    if (!stillOwned || stillOwned.token !== token) return;
    await fs.rm(lockPath, { recursive: true, force: true });
    return;
  }
  await fs.rm(released, { recursive: true, force: true });
}

export async function withLocalFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: LocalFileLockOptions = {},
): Promise<T> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  const pollMs = Math.max(1, options.pollMs ?? 25);
  const orphanGraceMs = Math.max(100, options.orphanGraceMs ?? 2_000);
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  const owner = newOwner(token);

  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    let acquired = false;
    let collided = false;
    let blockedByReaper = false;
    const acquisitionIntent = await createIntent(lockPath, "acquire");
    try {
      // The intent closes the check/create race: a reaper that starts after this check must wait for
      // our intent to drain before inspecting the canonical lock. If a reaper was already published,
      // this attempt backs off without ever creating a replacement generation beneath it.
      blockedByReaper = (await activeIntents(lockPath, "reap", orphanGraceMs)).length > 0;
      if (!blockedByReaper) {
        try {
          await fs.mkdir(lockPath, { mode: 0o700 });
          try {
            await fs.writeFile(ownerFile(lockPath), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
            acquired = true;
          } catch (error) {
            await quarantineAndRemove(lockPath).catch(() => {});
            throw error;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          collided = true;
        }
      }
    } finally {
      try {
        await removeIntent(acquisitionIntent.path);
      } catch (error) {
        // Never enter the critical section with a live acquisition intent left behind: waiters would
        // correctly treat it as an in-flight generation forever while this process remains alive.
        if (acquired) await releaseOwnedLock(lockPath, token).catch(() => {});
        throw error;
      }
    }

    if (acquired) break;

    if (collided && !blockedByReaper) {
      // Every reaper publishes a unique intent before waiting for all acquisition intents. New
      // acquisitions see at least that intent and back off. Multiple reapers may inspect the same
      // stale generation, but no replacement can appear until every one has removed its intent, so
      // a losing rename can only see ENOENT — never a newly acquired live lock.
      const reaperIntent = await createIntent(lockPath, "reap");
      let reaped = false;
      try {
        for (;;) {
          if ((await activeIntents(lockPath, "acquire", orphanGraceMs)).length === 0) break;
          if (Date.now() >= deadline) {
            throw new LocalFileLockTimeoutError(lockPath, timeoutMs, await readOwner(lockPath));
          }
          const remaining = Math.max(1, deadline - Date.now());
          const delay = Math.min(remaining, pollMs + Math.floor(Math.random() * Math.max(1, pollMs)));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        reaped = await reapDeadSameHostOwner(lockPath, orphanGraceMs);
      } finally {
        await removeIntent(reaperIntent.path);
      }
      if (reaped) continue;
    }

    if (Date.now() >= deadline) {
      throw new LocalFileLockTimeoutError(lockPath, timeoutMs, await readOwner(lockPath));
    }
    const remaining = Math.max(1, deadline - Date.now());
    const delay = Math.min(remaining, pollMs + Math.floor(Math.random() * Math.max(1, pollMs)));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

export function withLocalVaultMutationLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  return withLocalFileLock(localVaultMutationLockPath(userId), operation);
}

export function withLocalUsageRefreshLock<T>(
  userId: string,
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLocalFileLock(localUsageRefreshLockPath(userId, accountId), operation);
}
