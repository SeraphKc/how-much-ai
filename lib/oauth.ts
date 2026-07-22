// Browser-side PKCE helpers for a Claude subscription login owned only by this app.
// The user authorizes once, then the server exchanges the single-use code and stores the
// renewable credential in the encrypted vault. The verifier is not a credential and never leaves
// this browser except for the one authenticated exchange request.

export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  // Least privilege for the two endpoints this product calls. The same public client supports a
  // one-scope inference-only grant; adding user:profile is what Anthropic's usage endpoint requires.
  scopes: "user:profile user:inference",
} as const;

export interface PkceBundle {
  verifier: string;
  challenge: string;
  state: string;
  createdAt: number;
}

const PKCE_KEY = "usage.pkce.v2";
const PKCE_MAX_AGE_MS = 30 * 60_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validBundle(value: unknown, now = Date.now()): value is PkceBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<PkceBundle>;
  return Boolean(
    typeof bundle.verifier === "string" &&
      bundle.verifier.length >= 43 &&
      bundle.verifier.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.verifier) &&
      typeof bundle.challenge === "string" &&
      bundle.challenge.length >= 43 &&
      bundle.challenge.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.challenge) &&
      typeof bundle.state === "string" &&
      bundle.state.length >= 32 &&
      bundle.state.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.state) &&
      typeof bundle.createdAt === "number" &&
      Number.isFinite(bundle.createdAt) &&
      bundle.createdAt <= now &&
      now - bundle.createdAt <= PKCE_MAX_AGE_MS,
  );
}

export async function createPkce(now = Date.now()): Promise<PkceBundle> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    state: base64url(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: now,
  };
}

export async function loadOrCreatePkce(): Promise<PkceBundle> {
  if (typeof window !== "undefined") {
    try {
      const stored = window.sessionStorage.getItem(PKCE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (validBundle(parsed)) return parsed;
      }
    } catch {
      // Create a fresh bundle below when storage is unavailable or malformed.
    }
  }

  const bundle = await createPkce();
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(PKCE_KEY, JSON.stringify(bundle));
    } catch {
      // The in-memory bundle remains usable for this open modal.
    }
  }
  return bundle;
}

export function clearPkce(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PKCE_KEY);
  } catch {
    // Nothing else is required; authorization codes are single-use.
  }
}

export function buildAuthorizeUrl(bundle: PkceBundle): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: bundle.challenge,
    code_challenge_method: "S256",
    state: bundle.state,
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

// Claude's callback displays `code#state`. Also accept the full callback URL so copying the address
// bar works. State is mandatory in the UI before the code is sent to the server.
export function parsePastedCode(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { code: "" };
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code")?.trim();
    if (code) {
      return {
        code,
        state: url.searchParams.get("state")?.trim() || url.hash.slice(1).trim() || undefined,
      };
    }
  } catch {
    // Raw callback text falls through.
  }
  const separator = trimmed.lastIndexOf("#");
  if (separator < 0) return { code: trimmed };
  return {
    code: trimmed.slice(0, separator).trim(),
    state: trimmed.slice(separator + 1).trim() || undefined,
  };
}
