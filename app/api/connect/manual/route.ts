import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { AnthropicError, isProfilePermissionError } from "@/lib/anthropic";
import {
  ProfileUnavailableAccountError,
  saveDedicatedAccountWithoutProfile,
  saveResolvedAccount,
  resolveProviderAccount,
  saveProviderAccount,
} from "@/lib/connect-account";
import { getProvider, ProviderError } from "@/lib/providers/index";
import { fetchUsageOnce } from "@/lib/usage-service";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";
import type { AccountTokens } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Durable manual connection. The browser supplies a freshly created credential, but success is not
// returned until identity/usage verification, reconnect targeting, and encrypted vault
// persistence have all completed. The unsaved credential is never refreshed or echoed back.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 40 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }

  const raw = body.tokens as Partial<AccountTokens> | null | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.accessToken !== "string" ||
    !raw.accessToken.trim() ||
    raw.accessToken.length > 16 * 1024 ||
    (raw.refreshToken !== undefined &&
      raw.refreshToken !== null &&
      (typeof raw.refreshToken !== "string" || !raw.refreshToken.trim() || raw.refreshToken.length > 16 * 1024)) ||
    (raw.expiresAt !== undefined &&
      (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt) || raw.expiresAt < 0))
  ) {
    return NextResponse.json({ error: "Invalid or missing account token" }, { status: 400 });
  }
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" || !body.expectedAccountId.trim() || body.expectedAccountId.length > 200)
  ) {
    return NextResponse.json({ error: "Invalid expected account id" }, { status: 400 });
  }

  const tokens: AccountTokens = {
    accessToken: raw.accessToken.trim(),
    refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : null,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
  };
  const expectedAccountId =
    typeof body.expectedAccountId === "string" ? body.expectedAccountId.trim() : undefined;

  if (body.provider !== undefined && body.provider !== "anthropic" && body.provider !== "openai") {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }
  const provider = body.provider === "openai" ? "openai" : "anthropic";

  // OpenAI (ChatGPT/Codex): verify the pasted credential against /wham/usage, then save.
  if (provider === "openai") {
    try {
      const { identity } = await resolveProviderAccount(tokens, "openai");
      if (expectedAccountId && identity.id !== expectedAccountId) {
        return NextResponse.json(
          { error: `Those credentials belong to ${identity.email}. Reconnect the account named in the dialog instead.` },
          { status: 409 },
        );
      }
      const info = await saveProviderAccount(userId, identity, tokens, "openai");
      const usage = await getProvider("openai").fetchUsage(tokens).catch(() => null);
      return NextResponse.json({
        ok: true,
        id: info.id,
        email: info.email,
        plan: info.plan,
        label: info.label,
        alreadyConnected: info.alreadyConnected,
        usage,
        profile: null,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        const status = [400, 401, 403, 404, 409, 422, 429].includes(error.status) ? error.status : 502;
        return NextResponse.json({ error: error.message }, { status });
      }
      const { errorId } = reportServerError("connect.manual.save", error);
      return NextResponse.json(
        { error: "The account was verified, but its encrypted credential could not be saved. Try again.", errorId },
        { status: 500 },
      );
    }
  }

  try {
    const { usage, profile } = await fetchUsageOnce(tokens);
    if (profile === null) {
      const info = await saveDedicatedAccountWithoutProfile(userId, tokens, expectedAccountId);
      return NextResponse.json({
        ok: true,
        id: info.id,
        email: info.email,
        plan: info.plan,
        label: info.label,
        alreadyConnected: info.alreadyConnected,
        usage,
        profile: null,
      });
    }
    const accountId = profile.account?.uuid;
    if (!accountId) {
      return NextResponse.json(
        { error: "Claude accepted the token, but did not return a stable account identity." },
        { status: 502 },
      );
    }
    if (expectedAccountId && accountId !== expectedAccountId) {
      return NextResponse.json(
        {
          error: `Those credentials belong to ${profile.account?.email ?? "a different account"}. Reconnect the account named in the dialog instead.`,
        },
        { status: 409 },
      );
    }

    const info = await saveResolvedAccount(userId, profile, tokens);
    return NextResponse.json({
      ok: true,
      id: info.id,
      email: info.email,
      plan: info.plan,
      label: info.label,
      alreadyConnected: info.alreadyConnected,
      usage,
      profile,
    });
  } catch (error) {
    if (error instanceof ProfileUnavailableAccountError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof AnthropicError) {
      if (tokens.refreshToken === null && isProfilePermissionError(error)) {
        return NextResponse.json(
          {
            error:
              "Claude setup-token credentials are inference-only and cannot read subscription usage. Use the private app login instead.",
          },
          { status: 422 },
        );
      }
      const status = error.status === 429 ? 429 : [400, 401, 403, 404].includes(error.status) ? 401 : 502;
      return NextResponse.json({ error: error.message }, { status });
    }
    const { errorId } = reportServerError("connect.manual.save", error);
    return NextResponse.json(
      { error: "The account was verified, but its encrypted credential could not be saved. Try again.", errorId },
      { status: 500 },
    );
  }
}
