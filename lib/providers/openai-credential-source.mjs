// Dependency-free ESM core for the OpenAI (ChatGPT/Codex) credential. Kept plain JS with only
// dynamically-imported Node built-ins (inside the file-read helper) so the token-parsing/JWT-decode
// half is safe to import in the browser (the Connect dialog parses a pasted `~/.codex/auth.json`),
// while `bin/connect.mjs` and the server route can also read the file. JWT payloads are decoded for
// identity/expiry ONLY and never trusted for authorization.

export const CODEX_AUTH_FILENAME = "auth.json";
export const CODEX_AUTH_DIRNAME = ".codex";
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export class CodexCredentialError extends Error {
  constructor(message, recommendation) {
    super(message);
    this.name = "CodexCredentialError";
    this.recommendation = recommendation ?? "Sign in with the Codex CLI (`codex login`), then try again.";
  }
}

function b64urlToString(segment) {
  let b64 = String(segment).replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Decode a JWT's payload segment to an object (no signature verification). Null on any failure. */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(b64urlToString(parts[1]));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function openaiAuthClaim(payload) {
  const claim = payload && payload[OPENAI_AUTH_CLAIM];
  return claim && typeof claim === "object" ? claim : {};
}

/** The ChatGPT account id embedded in an access/id token, or null. Used for the ChatGPT-Account-Id header. */
export function chatgptAccountId(token) {
  const claim = openaiAuthClaim(decodeJwtPayload(token));
  return typeof claim.chatgpt_account_id === "string" ? claim.chatgpt_account_id : null;
}

/** The plan slug ("pro"/"plus"/"team"/"prolite"/…) from an id/access token, or null. */
export function planTypeFromToken(token) {
  const claim = openaiAuthClaim(decodeJwtPayload(token));
  return typeof claim.chatgpt_plan_type === "string" ? claim.chatgpt_plan_type : null;
}

/** The email claim from an id token, or null. */
export function emailFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.email === "string") return payload.email;
  const profile = payload && payload["https://api.openai.com/profile"];
  if (profile && typeof profile.email === "string") return profile.email;
  return null;
}

/** Epoch-ms expiry from an access token's `exp` claim; falls back to +10 days when absent. */
export function expiryFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (payload && typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
    return payload.exp * 1000;
  }
  return Date.now() + TEN_DAYS_MS;
}

/**
 * Pull `{ accessToken, refreshToken, expiresAt }` out of a credential blob: the full `~/.codex/auth.json`
 * (`{ tokens: { access_token, refresh_token, … } }`), a bare tokens object, or `{ access_token, … }`.
 * Returns null when no access token is present.
 */
export function extractOpenAITokens(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const tokens = obj.tokens && typeof obj.tokens === "object" ? obj.tokens : obj;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const refreshRaw = tokens.refresh_token ?? tokens.refreshToken;
  return {
    accessToken,
    refreshToken: typeof refreshRaw === "string" && refreshRaw ? refreshRaw : null,
    expiresAt: expiryFromAccessToken(accessToken),
  };
}

/** Read THIS machine's raw `~/.codex/auth.json`. Server/CLI only (dynamically imports Node built-ins). */
export async function readCodexAuthRaw(deps = {}) {
  const readFile = deps.readFile ?? (await import("node:fs/promises")).readFile;
  const homedir = deps.homedir ?? (await import("node:os")).homedir;
  const { join } = await import("node:path");
  const file = join(homedir(), CODEX_AUTH_DIRNAME, CODEX_AUTH_FILENAME);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new CodexCredentialError(
        "No Codex credential was found on this machine (~/.codex/auth.json).",
        "Sign in with the Codex CLI (`codex login`), then try again.",
      );
    }
    throw error;
  }
}
