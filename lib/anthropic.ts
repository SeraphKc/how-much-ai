// Server-side calls to Anthropic's OAuth + usage endpoints.
// This module only runs in route handlers (the browser can't call these APIs directly — no CORS).

import type { AccountTokens, ProfileData, UsageData } from "./types";

// platform.claude.com is the current Claude Code token host.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZATION_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_BETA = "oauth-2025-04-20";
const UPSTREAM_TIMEOUT_MS = 15_000;
export const REFRESH_TOKEN_TIMEOUT_MS = 60_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
// Without a claude-code User-Agent the usage endpoint lands in an aggressively rate-limited bucket.
const USER_AGENT = "claude-code/2.1.206";

// Public-client values used by Claude Code's subscription OAuth flow. The browser-side PKCE flow
// must request this exact redirect and scope set; the server exchanges its code only once below.
export const CLAUDE_SUBSCRIPTION_OAUTH = {
  clientId: CLIENT_ID,
  redirectUri: AUTHORIZATION_REDIRECT_URI,
  scopes: "user:profile user:inference",
} as const;

export class AnthropicError extends Error {
  readonly status: number;
  readonly errorType?: string;
  readonly permission?: string;
  readonly structured: boolean;

  constructor(
    message: string,
    status: number,
    metadata: { errorType?: string; permission?: string; structured?: boolean } = {},
  ) {
    super(message);
    this.name = "AnthropicError";
    this.status = status;
    this.errorType = metadata.errorType;
    this.permission = metadata.permission;
    this.structured = metadata.structured ?? false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(" ");
  }
  return undefined;
}

// Upstream messages are useful, but response bodies and credentials are not. Only display a
// bounded scalar field extracted from structured JSON, with common bearer-token shapes redacted.
function safeUpstreamMessage(value: unknown): string | undefined {
  const text = stringValue(value)?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const redacted = text
    .replace(/\bsk-ant-[a-z0-9_-]+\b/gi, "[redacted credential]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted credential]");
  return redacted.slice(0, 300);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function permissionFrom(...sources: Array<Record<string, unknown> | null>): string | undefined {
  const fields = [
    "permission",
    "permissions",
    "required_permission",
    "required_permissions",
    "missing_permission",
    "missing_permissions",
    "scope",
    "scopes",
    "required_scope",
    "required_scopes",
    "missing_scope",
    "missing_scopes",
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const field of fields) {
      const value = safeUpstreamMessage(source[field]);
      if (value) return value;
    }
  }
  return undefined;
}

function describeBearerError(body: string, status: number): AnthropicError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Do not echo an HTML error page, proxy response, or arbitrary text into the product UI.
    return new AnthropicError(`Anthropic returned ${status}`, status);
  }

  const top = asRecord(parsed);
  if (!top) return new AnthropicError(`Anthropic returned ${status}`, status);
  const nested = asRecord(top.error);
  const nestedDetails = asRecord(nested?.details);
  const topDetails = asRecord(top.details);
  const errorType = firstString(
    nested?.type,
    nested?.code,
    typeof top.error === "string" ? top.error : undefined,
    top.code,
    top.type,
  );
  const message = safeUpstreamMessage(
    firstString(nested?.message, nested?.error_description, top.message, top.error_description),
  );
  const permission = permissionFrom(nested, nestedDetails, top, topDetails);

  return new AnthropicError(message ?? `Anthropic returned ${status}`, status, {
    errorType,
    permission,
    structured: true,
  });
}

function containsExactProfileScope(value: string | undefined): boolean {
  return value !== undefined && /(?:^|[^a-z0-9:_-])user:profile(?:$|[^a-z0-9:_-])/i.test(value);
}

// A dedicated `claude setup-token` may intentionally lack the identity-only profile permission.
// Callers may ignore that one narrow failure while still treating every other 403 as an error.
export function isProfilePermissionError(error: unknown): error is AnthropicError {
  if (!(error instanceof AnthropicError) || error.status !== 403 || !error.structured) return false;
  const errorType = error.errorType?.toLowerCase() ?? "";
  const permissionFailure =
    errorType.includes("permission") || errorType.includes("insufficient_scope") || errorType.includes("forbidden");
  return permissionFailure && (containsExactProfileScope(error.permission) || containsExactProfileScope(error.message));
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account?: { uuid?: string; email_address?: string } | null;
  organization?: { uuid?: string; name?: string } | null;
}

// Anthropic access tokens live ~8h. If a refresh response omits expires_in, default to
// 8h rather than 1h — an under-estimate would trigger 8× more single-use rotations,
// multiplying the chance of a failed refresh cycle.
const DEFAULT_EXPIRES_IN = 8 * 60 * 60;

function normalizeTokens(data: TokenResponse, fallbackRefresh: string | null): AccountTokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + (data.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
  };
}

// Anthropic returns errors in two shapes depending on the surface:
//   OAuth style:  { error: "invalid_grant", error_description: "..." }
//   API style:    { error: { type: "rate_limit_error", message: "..." } }
// Pull a clean human string out of either, and never let an object reach `new Error()`
// (which would stringify it to the literal "[object Object]").
function describeTokenError(data: unknown, status: number, refreshing: boolean): { message: string; type?: string } {
  const d = asRecord(data) ?? {};
  const err = d.error;

  let type: string | undefined;
  let raw: string | undefined;

  if (typeof err === "string") {
    type = err;
    raw = typeof d.error_description === "string" ? d.error_description : err;
  } else if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    type = typeof e.type === "string" ? e.type : undefined;
    raw = typeof e.message === "string" ? e.message : undefined;
  } else if (typeof d.message === "string") {
    raw = d.message;
  }

  // Friendly copy for the failure modes a user connecting an account will actually hit.
  // Note: Anthropic answers INVALID codes with 429 rate_limit_error too (anti-brute-force
  // obfuscation), so a 429 here usually means a stale/used code, not an actual rate limit.
  const key = (type ?? "").toLowerCase();
  if (
    refreshing &&
    (status === 400 || status === 401 || status === 403 || status === 404 || key.includes("invalid_grant"))
  ) {
    return { message: "This Claude session expired or was already rotated. Reconnect the account to continue.", type };
  }
  if (refreshing && status === 429) {
    return { message: "Anthropic temporarily throttled automatic renewal. The app will retry after a cooldown.", type };
  }
  if (status === 429 || key.includes("rate_limit")) {
    return {
      message:
        "Anthropic turned down the sign-in — usually the code was stale or already used. Get a fresh code from step 1 and try again (if it keeps happening, wait a minute).",
      type,
    };
  }
  if (key.includes("invalid_grant") || key.includes("not_found") || status === 404) {
    return {
      message: "That code didn't work — it may have expired or already been used. Start over from step 1 and paste a fresh code.",
      type,
    };
  }
  if (key.includes("invalid_client") || key.includes("unauthorized")) {
    return { message: "Anthropic rejected the sign-in. Start over from step 1 to get a new code.", type };
  }

  return { message: safeUpstreamMessage(raw) || `Anthropic returned ${status} during sign-in.`, type };
}

function describeAuthorizationCodeError(data: unknown, status: number): string {
  const body = asRecord(data);
  const nested = asRecord(body?.error);
  const type = firstString(
    typeof body?.error === "string" ? body.error : undefined,
    nested?.type,
    nested?.code,
    body?.type,
    body?.code,
  )?.toLowerCase() ?? "";
  if (status === 429 || type.includes("rate_limit")) {
    return "Claude temporarily declined the authorization code. Wait a minute, then start the connection again.";
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || type.includes("invalid_grant")) {
    return "That Claude authorization code was invalid, expired, or already used. Start the connection again.";
  }
  return "Claude could not complete the authorization-code exchange. Start the connection again.";
}

// Match the current Claude Code token endpoint: JSON only. Usage/profile requests still carry the
// OAuth beta header and Claude Code user-agent below, but token exchange/renewal do not.
const TOKEN_HEADERS = {
  "Content-Type": "application/json",
};

async function postTokenOnce(body: Record<string, string>): Promise<Response> {
  // Refresh tokens are single-use, so give renewal materially longer than ordinary bearer reads.
  // A timeout/network error is still irreducibly ambiguous: the server may have consumed the token
  // and returned a replacement that the network lost. No client can recover that unseen response.
  // Never resubmit the same grant inside this request through a fallback or retry loop; a later
  // coordinated poll is the only remaining chance if the server never consumed it.
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TOKEN_TIMEOUT_MS),
  });
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await postTokenOnce(body);

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const status = res.status === 200 ? 502 : res.status;
    const { message } = describeTokenError(data, status, body.grant_type === "refresh_token");
    throw new AnthropicError(message, status);
  }
  return data as TokenResponse;
}

export async function refreshTokens(refreshToken: string, scope?: string): Promise<AccountTokens> {
  const data = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...(scope ? { scope } : {}),
  });
  if (!data.refresh_token) {
    throw new AnthropicError("Anthropic renewed the access token without returning a replacement refresh token.", 502);
  }
  return normalizeTokens(data, refreshToken);
}

// Authorization codes and their PKCE grants are single-use. A timeout, transport failure, or 5xx
// is ambiguous: Claude may already have consumed the code. Never retry it and never send it to a
// fallback host. The caller verifies usage/profile and persists the returned pair transactionally.
export async function exchangeSubscriptionCode(
  code: string,
  state: string | undefined,
  verifier: string,
): Promise<AccountTokens> {
  let res: Response;
  try {
    // Match the current Claude Code authorization-code exchange: JSON content type only, a
    // 30-second deadline, and no beta header, custom user-agent, retry, or fallback host.
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        ...(state ? { state } : {}),
        client_id: CLAUDE_SUBSCRIPTION_OAUTH.clientId,
        redirect_uri: CLAUDE_SUBSCRIPTION_OAUTH.redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new AnthropicError(
      "Claude's authorization service could not be reached. The one-time code was not retried; start the connection again.",
      502,
    );
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new AnthropicError(describeAuthorizationCodeError(data, res.status), res.status);
  const payload = asRecord(data);
  const accessToken = payload?.access_token;
  const refreshToken = payload?.refresh_token;
  const expiresIn = payload?.expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    accessToken.length > 16 * 1024 ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    refreshToken.length > 16 * 1024 ||
    (expiresIn !== undefined &&
      (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0))
  ) {
    throw new AnthropicError("Claude returned an incomplete authorization credential. Start the connection again.", 502);
  }

  const grantedScope = payload?.scope;
  if (grantedScope !== undefined) {
    if (typeof grantedScope !== "string") {
      throw new AnthropicError("Claude returned an invalid authorization scope. Start the connection again.", 502);
    }
    const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
    const missing = CLAUDE_SUBSCRIPTION_OAUTH.scopes.split(" ").filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new AnthropicError(
        "Claude did not grant all permissions required for subscription monitoring. Start the connection again.",
        403,
      );
    }
  }

  return normalizeTokens(
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(typeof expiresIn === "number" ? { expires_in: expiresIn } : {}),
      ...(typeof grantedScope === "string" ? { scope: grantedScope } : {}),
    },
    refreshToken,
  );
}

async function getWithBearer<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw describeBearerError(body, res.status);
  }
  return (await res.json()) as T;
}

export async function fetchUsage(accessToken: string): Promise<UsageData> {
  return getWithBearer<UsageData>(USAGE_URL, accessToken);
}

export async function fetchProfile(accessToken: string): Promise<ProfileData> {
  return getWithBearer<ProfileData>(PROFILE_URL, accessToken);
}
