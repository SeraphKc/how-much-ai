import { after, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalFileLockTimeoutError,
  localUsageRefreshLockPath,
  withLocalFileLock,
  withLocalUsageRefreshLock,
} from "./local-file-lock.ts";

const originalDataDir = process.env.VAULT_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-local-lock-"));
process.env.VAULT_DATA_DIR = dataDir;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function writeOwner(
  lockPath: string,
  owner: { token: string; pid: number; hostname: string; createdAt?: number },
): Promise<void> {
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), ...owner }),
    { mode: 0o600 },
  );
}

after(async () => {
  if (originalDataDir === undefined) delete process.env.VAULT_DATA_DIR;
  else process.env.VAULT_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("local usage lock serializes independent contenders and cleans up ownership", async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const operation = (name: string, delay: number) =>
    withLocalUsageRefreshLock("default", "account", async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${name}:end`);
      active -= 1;
    });

  await Promise.all([operation("first", 40), operation("second", 1)]);
  assert.equal(peak, 1);
  assert.ok(
    JSON.stringify(order) === JSON.stringify(["first:start", "first:end", "second:start", "second:end"]) ||
      JSON.stringify(order) === JSON.stringify(["second:start", "second:end", "first:start", "first:end"]),
  );
  await assert.rejects(fs.stat(localUsageRefreshLockPath("default", "account")), { code: "ENOENT" });
});

test("a dead same-host owner is safely reaped before acquisition", async () => {
  const lockPath = path.join(dataDir, ".locks", "dead-owner.lock");
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeOwner(lockPath, {
    token: "dead-token",
    pid: 2_000_000_000,
    hostname: os.hostname(),
    createdAt: Date.now() - 10_000,
  });

  let ran = false;
  await withLocalFileLock(
    lockPath,
    async () => {
      ran = true;
    },
    { timeoutMs: 1_000, pollMs: 5, orphanGraceMs: 100 },
  );
  assert.equal(ran, true);
});

test("an ownerless orphan is reaped after its grace period", async () => {
  const lockPath = path.join(dataDir, ".locks", "ownerless.lock");
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(lockPath, old, old);

  let ran = false;
  await withLocalFileLock(
    lockPath,
    async () => {
      ran = true;
    },
    { timeoutMs: 1_000, pollMs: 5, orphanGraceMs: 100 },
  );
  assert.equal(ran, true);
});

test("a foreign-host owner remains fail-closed", async () => {
  const lockPath = path.join(dataDir, ".locks", "foreign-owner.lock");
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeOwner(lockPath, {
    token: "foreign-token",
    pid: 2_000_000_000,
    hostname: `${os.hostname()}-other-host`,
    createdAt: Date.now() - 10_000,
  });

  await assert.rejects(
    () => withLocalFileLock(lockPath, async () => {}, { timeoutMs: 60, pollMs: 2, orphanGraceMs: 10 }),
    (error: unknown) => error instanceof LocalFileLockTimeoutError,
  );
  assert.equal(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).token, "foreign-token");
  await fs.rm(lockPath, { recursive: true, force: true });
});

test("stale reaping is fenced against a replacement acquisition", async (t) => {
  const lockPath = path.join(dataDir, ".locks", "reaper-race.lock");
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeOwner(lockPath, {
    token: "dead-race-token",
    pid: 2_000_000_000,
    hostname: os.hostname(),
    createdAt: Date.now() - 10_000,
  });

  const firstReaperEntered = deferred();
  const letFirstReaperFinish = deferred();
  const secondAcquireIntentRemoved = deferred();
  const originalRename: typeof fs.rename = fs.rename.bind(fs);
  const originalWriteFile: typeof fs.writeFile = fs.writeFile.bind(fs);
  const originalUnlink: typeof fs.unlink = fs.unlink.bind(fs);
  let staleRenameCalls = 0;
  let acquireIntentWrites = 0;
  let secondAcquireIntent = "";

  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const [oldPath, newPath] = args;
    if (String(oldPath) === lockPath && String(newPath).includes(".reaped-")) {
      staleRenameCalls += 1;
      if (staleRenameCalls === 1) {
        firstReaperEntered.resolve();
        await letFirstReaperFinish.promise;
      }
    }
    return originalRename(...args);
  });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    const [file] = args;
    const result = await originalWriteFile(...args);
    if (String(file).startsWith(`${lockPath}.acquire-`)) {
      acquireIntentWrites += 1;
      if (acquireIntentWrites === 2) secondAcquireIntent = String(file);
    }
    return result;
  });
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    const [file] = args;
    const result = await originalUnlink(...args);
    if (String(file) === secondAcquireIntent) secondAcquireIntentRemoved.resolve();
    return result;
  });

  let active = 0;
  let peak = 0;
  const contender = () =>
    withLocalFileLock(
      lockPath,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      { timeoutMs: 2_000, pollMs: 2, orphanGraceMs: 10 },
    );

  const first = contender();
  await firstReaperEntered.promise;
  const second = contender();
  await secondAcquireIntentRemoved.promise;
  assert.equal(staleRenameCalls, 1, "the published reaper gate kept the second waiter away from rename");

  letFirstReaperFinish.resolve();
  await Promise.all([first, second]);
  assert.equal(peak, 1, "the replacement lock remained exclusive");
  const remaining = (await fs.readdir(path.dirname(lockPath))).filter((name) =>
    name.startsWith(`${path.basename(lockPath)}.`),
  );
  assert.deepEqual(remaining, [], "unique acquisition/reaper intents are cleaned up");
});

test("a delayed release never removes a replacement owner's lock", async () => {
  const lockPath = path.join(dataDir, ".locks", "release-token.lock");
  const displaced = `${lockPath}.displaced`;

  await withLocalFileLock(lockPath, async () => {
    await fs.rename(lockPath, displaced);
    await fs.mkdir(lockPath, { mode: 0o700 });
    await writeOwner(lockPath, {
      token: "replacement-token",
      pid: process.pid,
      hostname: os.hostname(),
    });
  });

  assert.equal(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).token, "replacement-token");
  await Promise.all([
    fs.rm(lockPath, { recursive: true, force: true }),
    fs.rm(displaced, { recursive: true, force: true }),
  ]);
});
