// OpenAI (ChatGPT / Codex) provider. Reads the local Codex OAuth credential (or a pasted one),
// refreshes it against auth.openai.com, and reads read-only subscription usage from
// chatgpt.com/backend-api/wham/usage — no inference is spent. Endpoints/headers verified live; see
// docs/provider-research.md. Uses global `fetch` (tests stub `globalThis.fetch`, matching the repo).

import { ProviderError } from "./types";
import type { Provider, ProviderProfile } from "./types";
import type { AccountTokens, UsageData } from "../types";
import { normalizeOpenAIUsage, type WhamUsagePayload } from "./openai-usage";
import {
  chatgptAccountId,
  CodexCredentialError,
  emailFromToken,
  expiryFromAccessToken,
  extractOpenAITokens,
  planTypeFromToken,
  readCodexAuthRaw,
} from "./openai-credential-source.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Cloudflare gates /wham/usage on the path, not the UA (verified), so we identify honestly.
const USER_AGENT = "how-much-ai/0.1.0";
const USAGE_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 30_000;

// Map ChatGPT's plan slug onto a display label. `prolite` is a Pro variant seen in the wild.
export function openaiPlanLabel(planType: string | null | undefined): string {
  switch ((planType ?? "").toLowerCase()) {
    case "pro":
      return "ChatGPT Pro";
    case "prolite":
      return "ChatGPT Pro";
    case "plus":
      return "ChatGPT Plus";
    case "team":
      return "ChatGPT Team";
    case "business":
      return "ChatGPT Business";
    case "enterprise":
      return "ChatGPT Enterprise";
    case "free":
      return "ChatGPT Free";
    default:
      return "ChatGPT";
  }
}

function describeUsageError(status: number, body: string): string {
  if (body.trimStart().startsWith("<")) {
    return `ChatGPT declined the usage request (HTTP ${status}). The Codex login may be expired or blocked.`;
  }
  if (status === 401) return "This ChatGPT login expired or was revoked. Reconnect the account.";
  return `ChatGPT returned ${status} while reading usage.`;
}

async function fetchWhamUsage(accessToken: string): Promise<WhamUsagePayload> {
  const accountId = chatgptAccountId(accessToken);
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  } catch {
    // Network failure / timeout — carry a .status so callers (and the connect routes) classify it as
    // an upstream error (502), not a save failure. Mirrors refresh()'s handling.
    throw new ProviderError("Couldn't reach ChatGPT to read usage. Check your connection and try again.", 502, "openai");
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) throw new ProviderError(describeUsageError(res.status, body), res.status, "openai");
  try {
    return JSON.parse(body) as WhamUsagePayload;
  } catch {
    throw new ProviderError("ChatGPT returned an unreadable usage response.", 502, "openai");
  }
}

export const openaiProvider: Provider = {
  id: "openai",
  label: "ChatGPT / Codex",
  supportsOAuth: false, // ships with one-click local read + manual paste

  async refresh(tokens: AccountTokens): Promise<AccountTokens> {
    if (!tokens.refreshToken) {
      throw new ProviderError("This ChatGPT login has no refresh token; reconnect it.", 401, "openai");
    }
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError("Could not reach OpenAI to renew the ChatGPT login.", 502, "openai");
    }
    const data = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
    if (!res.ok || !data?.access_token) {
      const status = res.status === 200 ? 502 : res.status;
      throw new ProviderError(
        status === 400 || status === 401
          ? "This ChatGPT login expired or was already rotated. Reconnect the account."
          : `OpenAI declined the ChatGPT token renewal (HTTP ${status}).`,
        status,
        "openai",
      );
    }
    const accessToken = data.access_token;
    const refreshToken =
      typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : tokens.refreshToken;
    return { accessToken, refreshToken, expiresAt: expiryFromAccessToken(accessToken) };
  },

  async fetchUsage(tokens: AccountTokens): Promise<UsageData> {
    return normalizeOpenAIUsage(await fetchWhamUsage(tokens.accessToken));
  },

  async resolveIdentity(tokens: AccountTokens): Promise<ProviderProfile> {
    const payload = await fetchWhamUsage(tokens.accessToken);
    const accountId =
      chatgptAccountId(tokens.accessToken) ??
      (typeof payload.account_id === "string" ? payload.account_id : null) ??
      (typeof payload.user_id === "string" ? payload.user_id : null);
    if (!accountId) {
      throw new ProviderError("ChatGPT did not return a stable account identity.", 502, "openai");
    }
    const email =
      (typeof payload.email === "string" && payload.email) || emailFromToken(tokens.accessToken) || "unknown account";
    const plan = openaiPlanLabel(
      (typeof payload.plan_type === "string" && payload.plan_type) || planTypeFromToken(tokens.accessToken),
    );
    return { id: `openai-${accountId}`, email, plan };
  },

  async readLocalCredential(deps?: unknown): Promise<AccountTokens> {
    let raw: string;
    try {
      raw = await readCodexAuthRaw((deps as Record<string, unknown>) ?? {});
    } catch (err) {
      if (err instanceof CodexCredentialError) {
        throw new ProviderError(`${err.message} ${err.recommendation}`, 404, "openai");
      }
      throw new ProviderError("Couldn't read the local Codex credential.", 500, "openai");
    }
    const tokens = extractOpenAITokens(raw);
    if (!tokens) throw new ProviderError("The Codex credential on this machine is unreadable.", 422, "openai");
    return tokens;
  },

  parseManualCredential(raw: string): AccountTokens | null {
    return extractOpenAITokens(raw);
  },
};
