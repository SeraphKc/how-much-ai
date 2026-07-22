// Anthropic (Claude) provider — a thin adapter over the existing, battle-tested modules. No logic is
// moved here; this only re-expresses `lib/anthropic.ts` (+ format/credentials/local-credentials) in
// the shared `Provider` shape so the rest of the app can dispatch generically. The existing Anthropic
// tests continue to exercise the real modules unchanged.

import {
  fetchProfile,
  fetchUsage as anthropicFetchUsage,
  refreshTokens,
} from "../anthropic";
import { planLabel } from "../format";
import { parseCredentials } from "../credentials";
import { readLocalCredentialRaw, extractTokens } from "../local-credentials";
import type { AccountTokens, ProfileData, UsageData } from "../types";
import type { Provider, ProviderProfile } from "./types";

// Map a resolved Claude profile onto the normalized identity. Exported for unit testing the mapping
// without a network call.
export function anthropicIdentityFromProfile(profile: ProfileData): ProviderProfile {
  const uuid = profile.account?.uuid;
  if (!uuid) {
    throw new Error("Claude verified the credential but did not return a stable account identity.");
  }
  return {
    id: uuid,
    email: profile.account?.email ?? "unknown account",
    ...(profile.account?.full_name ? { fullName: profile.account.full_name } : {}),
    plan: planLabel(profile),
  };
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  label: "Claude",
  supportsOAuth: true,

  refresh(tokens: AccountTokens, opts?: { scopes?: string }): Promise<AccountTokens> {
    if (!tokens.refreshToken) {
      throw new Error("A rotating Claude credential requires a refresh token.");
    }
    return refreshTokens(tokens.refreshToken, opts?.scopes);
  },

  fetchUsage(tokens: AccountTokens): Promise<UsageData> {
    return anthropicFetchUsage(tokens.accessToken);
  },

  async resolveIdentity(tokens: AccountTokens): Promise<ProviderProfile> {
    const profile = await fetchProfile(tokens.accessToken);
    return anthropicIdentityFromProfile(profile);
  },

  async readLocalCredential(deps?: unknown): Promise<AccountTokens> {
    const raw = await readLocalCredentialRaw(deps as never);
    return extractTokens(raw);
  },

  parseManualCredential(raw: string): AccountTokens | null {
    return parseCredentials(raw)?.tokens ?? null;
  },
};
