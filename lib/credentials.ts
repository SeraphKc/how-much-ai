import type { AccountTokens } from "./types";

// The command that dumps Claude Code's stored OAuth credentials, per OS.
export const DUMP_COMMANDS = {
  macOS: `security find-generic-password -s "Claude Code-credentials" -w`,
  linux: `cat ~/.claude/.credentials.json`,
  windows: `type %USERPROFILE%\\.claude\\.credentials.json`,
};

export const LONG_LIVED_TOKEN_COMMAND = "claude setup-token";
export const LONG_LIVED_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

interface ParsedCredentials {
  tokens: AccountTokens;
  credentialKind: "long_lived" | "rotating";
  scopes?: string[];
  subscriptionType?: string;
}

// Accept whatever the user pastes: the full keychain/.credentials.json blob
// ({ claudeAiOauth: {...}, mcpOAuth: {...} }), a bare claudeAiOauth object,
// or a lone { accessToken, refreshToken, expiresAt }.
export function parseCredentials(raw: string): ParsedCredentials | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // `claude setup-token` creates a dedicated long-lived OAuth token for headless use. Accept the
    // token by itself or copied alongside the command's surrounding terminal text. It has no
    // rotating refresh token; this paste time supplies an estimated one-year renewal date while the
    // upstream 401 path remains the authority for revocation/expiry.
    const longLived = trimmed.match(/sk-ant-oat01-[A-Za-z0-9_-]+/)?.[0];
    if (longLived) {
      return {
        tokens: {
          accessToken: longLived,
          refreshToken: null,
          expiresAt: Date.now() + LONG_LIVED_TOKEN_LIFETIME_MS,
        },
        credentialKind: "long_lived",
      };
    }
    return null;
  }

  const root = obj as Record<string, unknown>;
  const oauth = (root.claudeAiOauth ?? root) as Record<string, unknown>;
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
  const suppliedExpiry = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;

  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresAt:
        refreshToken || suppliedExpiry > 0 ? suppliedExpiry : Date.now() + LONG_LIVED_TOKEN_LIFETIME_MS,
    },
    credentialKind: refreshToken ? "rotating" : "long_lived",
    scopes: Array.isArray(oauth.scopes) ? (oauth.scopes as string[]) : undefined,
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
  };
}
