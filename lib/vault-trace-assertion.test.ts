import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const assertionScript = path.join(process.cwd(), "scripts", "assert-no-vault-traces.mjs");

async function checkTrace(files: string[]) {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "how-much-ai-trace-"));
  try {
    await writeFile(path.join(traceRoot, "app.nft.json"), JSON.stringify({ files }), "utf8");
    return await execFileAsync(process.execPath, [assertionScript, traceRoot]);
  } finally {
    await rm(traceRoot, { recursive: true, force: true });
  }
}

test("production trace assertion permits application files with non-artifact vault names", async () => {
  const { stdout } = await checkTrace(["../lib/vault.ts", "../docs/token-recovery.md", "../lib/vault-key.ts"]);
  assert.match(stdout, /exclude local vault material/);
});

for (const artifact of [
  "../custom/vault.enc",
  "../custom/vault-user.enc.last-good",
  "../custom/vault.key",
  "../custom/token-recovery/account.enc",
  "..\\custom\\vault-team.enc.backup",
  "../.data/anything",
]) {
  test(`production trace assertion rejects ${artifact}`, async () => {
    await assert.rejects(
      () => checkTrace(["../lib/vault.ts", artifact]),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /Local vault material was traced/);
        return true;
      },
    );
  });
}
