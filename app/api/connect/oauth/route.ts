import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  AnthropicError,
  exchangeSubscriptionCode,
  fetchProfile,
  fetchUsage,
} from "@/lib/anthropic";
import { saveResolvedAccount } from "@/lib/connect-account";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 12 * 1024;
const CODE_LIMIT = 4 * 1024;
const STATE_LIMIT = 512;
const EXPECTED_ACCOUNT_LIMIT = 200;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALLOWED_FIELDS = new Set(["code", "state", "verifier", "expectedAccountId"]);

function upstreamStatus(status: number): number {
  if (status === 429) return 429;
  if ([400, 401, 403, 404].includes(status)) return 400;
  return 502;
}

// Authenticated transactional connection for an app-owned Claude subscription OAuth credential.
// The authorization code is exchanged once, its credential verifies both usage and profile, and
// the encrypted vault save completes before a success response. Tokens are never reflected.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, BODY_LIMIT);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    return NextResponse.json({ error: "OAuth completion contains unsupported fields" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  const state = typeof body.state === "string" ? body.state.trim() : undefined;
  const expectedAccountId =
    typeof body.expectedAccountId === "string" ? body.expectedAccountId.trim() : undefined;
  if (!code || code.length > CODE_LIMIT || /[\u0000-\u0020\u007f]/.test(code)) {
    return NextResponse.json({ error: "Invalid or missing authorization code" }, { status: 400 });
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    return NextResponse.json({ error: "Invalid or missing PKCE verifier" }, { status: 400 });
  }
  if (
    body.state !== undefined &&
    (typeof body.state !== "string" || !state || state.length > STATE_LIMIT || !STATE_PATTERN.test(state))
  ) {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" ||
      !expectedAccountId ||
      expectedAccountId.length > EXPECTED_ACCOUNT_LIMIT)
  ) {
    return NextResponse.json({ error: "Invalid expected account id" }, { status: 400 });
  }

  let tokens: Awaited<ReturnType<typeof exchangeSubscriptionCode>>;
  try {
    tokens = await exchangeSubscriptionCode(code, state, verifier);
  } catch (error) {
    if (error instanceof AnthropicError) {
      return NextResponse.json({ error: error.message }, { status: upstreamStatus(error.status) });
    }
    return NextResponse.json(
      { error: "Claude's authorization service could not complete the connection. Start again." },
      { status: 502 },
    );
  }

  let profile: Awaited<ReturnType<typeof fetchProfile>>;
  try {
    const verified = await Promise.all([fetchUsage(tokens.accessToken), fetchProfile(tokens.accessToken)]);
    profile = verified[1];
  } catch (error) {
    const status = error instanceof AnthropicError ? upstreamStatus(error.status) : 502;
    const message =
      status === 429
        ? "Claude temporarily rate-limited account verification. Start the connection again in a minute."
        : "Claude issued a credential but account verification failed. Start the connection again.";
    return NextResponse.json({ error: message }, { status });
  }

  const accountId = profile.account?.uuid;
  if (!accountId) {
    return NextResponse.json(
      { error: "Claude verified the credential but did not return a stable account identity." },
      { status: 502 },
    );
  }
  if (expectedAccountId && accountId !== expectedAccountId) {
    return NextResponse.json(
      {
        error: `This Claude login belongs to ${profile.account?.email ?? "a different account"}. Reconnect the selected account instead.`,
      },
      { status: 409 },
    );
  }

  try {
    const info = await saveResolvedAccount(userId, profile, tokens, "managed");
    return NextResponse.json({
      ok: true,
      id: info.id,
      email: info.email,
      plan: info.plan,
      label: info.label,
      alreadyConnected: info.alreadyConnected,
    });
  } catch (error) {
    const { errorId } = reportServerError("connect.oauth.save", error);
    return NextResponse.json(
      {
        error: "Claude was verified, but its encrypted credential could not be saved. Start the connection again.",
        errorId,
      },
      { status: 500 },
    );
  }
}
