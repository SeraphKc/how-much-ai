// @ts-check
// Shared, DEPENDENCY-FREE reader for the Claude Code credential stored on THIS machine.
//
// Deliberately plain ESM using only Node built-ins so BOTH consumers can use it with zero install:
//   - the self-hosted local-connect route (lib/local-credentials.ts wraps this), and
//   - the `bin/connect.mjs` CLI helper run via `npx` (which must start instantly, no `npm install`).
//
// It NEVER interpolates a shell string: the macOS keychain is read with execFile + a fixed argv, so
// there is no shell-injection surface. It returns the RAW credential JSON for the caller to parse.

import { execFile as _execFile } from "node:child_process";
import { readFile as _readFile } from "node:fs/promises";
import { homedir as _homedir } from "node:os";
import path from "node:path";

// The macOS Keychain generic-password entry Claude Code stores its OAuth credential under.
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

/** An error the UI/CLI can present, carrying an actionable next step in `recommendation`. */
export class LocalCredentialError extends Error {
  /**
   * @param {string} message
   * @param {string} recommendation - what the user should do next (shown in the UI / printed by the CLI).
   */
  constructor(message, recommendation) {
    super(message);
    this.name = "LocalCredentialError";
    this.recommendation = recommendation;
  }
}

/** @typedef {{ accessToken: string, refreshToken: string | null, expiresAt: number }} ExtractedTokens */

/**
 * @typedef {object} CredentialDeps
 * @property {NodeJS.Platform | string} [platform] - defaults to process.platform.
 * @property {(cmd: string, args: string[]) => Promise<string>} [execFile] - returns stdout.
 * @property {(file: string) => Promise<string>} [readFile] - returns file contents (utf8).
 * @property {() => string} [homedir]
 */

/**
 * Run a command with a fixed argv and NO shell. Returns stdout.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function defaultExecFile(cmd, args) {
  return new Promise((resolve, reject) => {
    // No `encoding` option → stdout is a utf8 string; no shell → args are passed literally.
    _execFile(cmd, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Read THIS machine's Claude Code credential and return the raw JSON string.
 *
 * Strategy: on macOS try the Keychain first (where recent Claude Code stores it), then fall back to
 * ~/.claude/.credentials.json (older macOS installs, and the canonical location on Linux/Windows).
 * If nothing is found, throw a LocalCredentialError with a recommendation.
 *
 * @param {CredentialDeps} [deps]
 * @returns {Promise<string>}
 */
export async function readLocalCredentialRaw(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const execFile = deps.execFile ?? defaultExecFile;
  const readFile = deps.readFile ?? ((/** @type {string} */ file) => _readFile(file, "utf8"));
  const homedir = deps.homedir ?? _homedir;

  // 1) macOS Keychain (fixed argv — no shell, no interpolation).
  if (platform === "darwin") {
    try {
      const out = await execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
      const trimmed = out.trim();
      if (trimmed) return trimmed;
    } catch {
      // No keychain entry (or `security` unavailable) — fall through to the file.
    }
  }

  // 2) ~/.claude/.credentials.json — canonical on Linux/Windows, and the older macOS location.
  const file = path.join(homedir(), ".claude", ".credentials.json");
  try {
    const content = await readFile(file);
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  } catch {
    // Fall through to the appropriate error below.
  }

  // 3) Nothing found — give a clear, OS-aware reason + recommendation.
  const supported = platform === "darwin" || platform === "linux" || platform === "win32";
  if (!supported) {
    throw new LocalCredentialError(
      `Unsupported OS "${String(platform)}" — can't auto-read the Claude Code credential here.`,
      "Add the account by pasting its token instead (the manual option below).",
    );
  }
  throw new LocalCredentialError(
    "Couldn't find a Claude Code credential on this machine.",
    "Make sure Claude Code is installed and signed in on this machine (run `claude` and log in), then try again — or add the account by pasting its token.",
  );
}

/**
 * Extract just the OAuth tokens from a raw credential blob. Accepts the full
 * `{ claudeAiOauth: {...} }` wrapper or a bare `{ accessToken, ... }` object. Missing
 * refreshToken/expiresAt default to null/0 rather than being invented.
 *
 * @param {string} raw
 * @returns {ExtractedTokens}
 */
export function extractTokens(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new LocalCredentialError(
      "The Claude Code credential wasn't valid JSON.",
      "Re-run the login for this account in Claude Code, then try again.",
    );
  }
  const oauth = obj && typeof obj === "object" && obj.claudeAiOauth ? obj.claudeAiOauth : obj;
  const accessToken = oauth && typeof oauth === "object" ? oauth.accessToken : undefined;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new LocalCredentialError(
      "The Claude Code credential didn't contain an access token.",
      "Sign in to Claude Code again for this account, then try again.",
    );
  }
  return {
    accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : null,
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0,
  };
}
