import { test } from "node:test";
import assert from "node:assert/strict";
import { readLocalCredentialRaw, extractTokens, LocalCredentialError } from "./local-credentials.ts";
import { parseCredentials } from "./credentials.ts";

const KEYCHAIN_BLOB = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"sk-ant-ort01-def","expiresAt":123}}';
const FILE_BLOB = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-file","refreshToken":"r","expiresAt":9}}';

// Build a deps object with fakes; unused ones throw so a wrong path is caught loudly.
function deps(over: Record<string, unknown> = {}) {
  return {
    platform: "darwin",
    execFile: async () => {
      throw new Error("execFile should not be called");
    },
    readFile: async () => {
      throw new Error("readFile should not be called");
    },
    homedir: () => "/home/tester",
    ...over,
  } as never;
}

// --- readLocalCredentialRaw: source selection ---------------------------------

test("macOS: reads the keychain via `security` with fixed args (no shell interpolation)", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const raw = await readLocalCredentialRaw(
    deps({
      platform: "darwin",
      execFile: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return KEYCHAIN_BLOB + "\n"; // security appends a trailing newline
      },
    }),
  );
  assert.equal(raw, KEYCHAIN_BLOB); // trimmed
  assert.deepEqual(calls, [{ cmd: "security", args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"] }]);
});

test("macOS: keychain miss falls back to ~/.claude/.credentials.json", async () => {
  const reads: string[] = [];
  const raw = await readLocalCredentialRaw(
    deps({
      platform: "darwin",
      execFile: async () => {
        throw new Error("item not found"); // keychain has no entry
      },
      readFile: async (p: string) => {
        reads.push(p);
        return FILE_BLOB;
      },
    }),
  );
  assert.equal(raw, FILE_BLOB);
  assert.equal(reads.length, 1);
  assert.match(reads[0], /\.claude[\/\\]\.credentials\.json$/);
});

test("macOS: an empty keychain result also falls through to the file", async () => {
  const raw = await readLocalCredentialRaw(
    deps({ platform: "darwin", execFile: async () => "   \n", readFile: async () => FILE_BLOB }),
  );
  assert.equal(raw, FILE_BLOB);
});

test("Linux: never touches the keychain, reads the credentials file", async () => {
  const raw = await readLocalCredentialRaw(
    deps({ platform: "linux", readFile: async () => FILE_BLOB }), // execFile stays the throwing default
  );
  assert.equal(raw, FILE_BLOB);
});

test("Windows: reads the credentials file too", async () => {
  const raw = await readLocalCredentialRaw(deps({ platform: "win32", readFile: async () => FILE_BLOB }));
  assert.equal(raw, FILE_BLOB);
});

// --- readLocalCredentialRaw: error paths --------------------------------------

test("no credential found on a supported OS → LocalCredentialError with a recommendation", async () => {
  await assert.rejects(
    readLocalCredentialRaw(
      deps({
        platform: "linux",
        readFile: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof LocalCredentialError);
      assert.ok((err as LocalCredentialError).recommendation.length > 0, "should carry a recommendation for the UI");
      return true;
    },
  );
});

test("unsupported OS with no credentials file → a clear 'unsupported OS' error", async () => {
  await assert.rejects(
    readLocalCredentialRaw(
      deps({
        platform: "sunos",
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof LocalCredentialError);
      assert.match((err as LocalCredentialError).message, /unsupported/i);
      return true;
    },
  );
});

// --- extractTokens (the parsing shared with the CLI helper) -------------------

test("extractTokens: pulls tokens out of the full keychain/.credentials.json blob", () => {
  assert.deepEqual(extractTokens(KEYCHAIN_BLOB), {
    accessToken: "sk-ant-oat01-abc",
    refreshToken: "sk-ant-ort01-def",
    expiresAt: 123,
  });
});

test("extractTokens: accepts a bare claudeAiOauth object (no wrapper)", () => {
  const bare = '{"accessToken":"sk-ant-oat01-x","refreshToken":"y","expiresAt":5}';
  assert.deepEqual(extractTokens(bare), { accessToken: "sk-ant-oat01-x", refreshToken: "y", expiresAt: 5 });
});

test("extractTokens: defaults a missing refreshToken/expiresAt rather than inventing them", () => {
  const partial = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-only"}}';
  assert.deepEqual(extractTokens(partial), { accessToken: "sk-ant-oat01-only", refreshToken: null, expiresAt: 0 });
});

test("extractTokens: no accessToken anywhere → LocalCredentialError (not a silent null)", () => {
  assert.throws(() => extractTokens('{"claudeAiOauth":{"refreshToken":"r"}}'), LocalCredentialError);
  assert.throws(() => extractTokens("not json at all"), LocalCredentialError);
});

// --- the raw blob is consumable by the app's existing parseCredentials --------

test("a keychain blob read here parses cleanly with lib/credentials parseCredentials", () => {
  const parsed = parseCredentials(KEYCHAIN_BLOB);
  assert.ok(parsed);
  assert.equal(parsed!.tokens.accessToken, "sk-ant-oat01-abc");
});
