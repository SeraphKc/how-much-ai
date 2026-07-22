import { NextResponse } from "next/server";
import { AnthropicError } from "@/lib/anthropic";
import { parseCredentials } from "@/lib/credentials";
import { normalizePairingCode, PAIRING_CODE_LENGTH } from "@/lib/pairing-core";
import {
  claimPairing,
  finalizePairing,
  pairingBackendAvailable,
  pairingRateBucket,
  preflightPairing,
} from "@/lib/pairings-store";
import { pairingAccountMatches, saveThenFinalizePairing } from "@/lib/pairing-completion";
import { resolveAccount, saveResolvedAccount } from "@/lib/connect-account";
import { readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";
import type { AccountTokens } from "@/lib/types";

// Node runtime: decrypts/writes the vault (node:crypto) and talks to Convex.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRING_BODY_LIMIT = 32 * 1024;
const TOKEN_FIELD_LIMIT = 16 * 1024;

// PUBLIC endpoint (no session — it's called by the `npx` CLI helper on the user's machine, which has
// no browser cookie). See proxy.ts PUBLIC_PATHS. It is safe to be public because the pairing code it
// requires is a ~60-bit single-use secret with a 10-minute TTL: guessing it is infeasible, and it
// works exactly once. The token is used to resolve+store the account, then discarded — NEVER logged
// or echoed back.
//
// Body: { code, token }. `token` may be the raw credential JSON string OR a
// { accessToken, refreshToken, expiresAt } object (what bin/connect.mjs sends).
export async function POST(req: Request) {
  let pairingAvailable: boolean;
  try {
    pairingAvailable = pairingBackendAvailable();
  } catch (error) {
    const { errorId } = reportServerError("connect.pair.preflight", error);
    return NextResponse.json(
      { ok: false, error: "Couldn't verify that pairing code. Try again shortly.", errorId },
      { status: 503 },
    );
  }
  if (!pairingAvailable) {
    return NextResponse.json({ ok: false, error: "Pairing isn't available on this deployment." }, { status: 501 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, PAIRING_BODY_LIMIT);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status });
  }

  const rawCode = typeof body.code === "string" && body.code.length <= 64 ? body.code : "";
  const code = normalizePairingCode(rawCode);
  if (code.length !== PAIRING_CODE_LENGTH) {
    return NextResponse.json({ ok: false, error: "Missing or malformed pairing code" }, { status: 400 });
  }

  // Reject unknown/expired/used codes, and enforce the distributed per-client throttle, before
  // parsing or forwarding any credential to Anthropic. This check does not consume a pending code;
  // the later claim remains the single transactional state transition.
  let preflight: Awaited<ReturnType<typeof preflightPairing>>;
  try {
    preflight = await preflightPairing(code, pairingRateBucket(req.headers), Date.now());
  } catch (error) {
    const { errorId } = reportServerError("connect.pair.preflight", error);
    return NextResponse.json(
      { ok: false, error: "Couldn't verify that pairing code. Try again shortly.", errorId },
      { status: 503 },
    );
  }
  if (!preflight.ok) {
    const messages: Record<string, [number, string]> = {
      not_found: [404, "That pairing code isn't valid. Open the app and start again to get a fresh code."],
      processing: [409, "That pairing code is already being completed. Check the app for its status."],
      done: [409, "That pairing code was already used. Start again in the app to get a fresh one."],
      failed: [409, "That pairing attempt failed. Start again in the app to get a fresh code."],
      expired: [410, "That pairing code expired. Start again in the app to get a fresh one."],
      rate_limited: [429, "Too many pairing attempts. Wait a few minutes before trying again."],
      attempts_exhausted: [
        429,
        "That code reached its verification limit. Start again in the app to get a fresh code.",
      ],
    };
    const [status, message] = messages[preflight.reason] ?? [400, "That pairing code can't be used."];
    const headers =
      status === 429 && preflight.retryAfterSeconds
        ? { "Retry-After": String(preflight.retryAfterSeconds) }
        : undefined;
    return NextResponse.json({ ok: false, error: message }, { status, headers });
  }

  // Accept either a raw blob string or a parsed tokens object.
  let tokens: AccountTokens | null = null;
  const t = body.token;
  if (typeof t === "string") {
    tokens = parseCredentials(t)?.tokens ?? null;
  } else if (t && typeof t === "object" && typeof (t as { accessToken?: unknown }).accessToken === "string") {
    const o = t as { accessToken: string; refreshToken?: unknown; expiresAt?: unknown };
    // Run object payloads through the same parser as pasted credentials. In particular, a dedicated
    // access-only setup token gets the same one-year expiry instead of being persisted with epoch 0.
    tokens =
      parseCredentials(
        JSON.stringify({
          accessToken: o.accessToken,
          ...(typeof o.refreshToken === "string" ? { refreshToken: o.refreshToken } : {}),
          ...(typeof o.expiresAt === "number" ? { expiresAt: o.expiresAt } : {}),
        }),
      )?.tokens ?? null;
  }
  if (
    !tokens ||
    !tokens.accessToken.trim() ||
    tokens.accessToken.length > TOKEN_FIELD_LIMIT ||
    (tokens.refreshToken !== null &&
      (!tokens.refreshToken.trim() || tokens.refreshToken.length > TOKEN_FIELD_LIMIT))
  ) {
    return NextResponse.json({ ok: false, error: "Missing account token" }, { status: 400 });
  }

  // 1) Resolve identity FIRST — a bad/expired token fails here WITHOUT burning the code, so the user
  //    can just re-run the helper. (The token is never logged.)
  let profile: Awaited<ReturnType<typeof resolveAccount>>["profile"];
  let resolvedTokens: AccountTokens;
  try {
    ({ profile, tokens: resolvedTokens } = await resolveAccount(tokens));
  } catch (err) {
    if (err instanceof AnthropicError) {
      const status = err.status === 429 ? 429 : err.status >= 400 && err.status < 500 ? 401 : 502;
      return NextResponse.json({ ok: false, error: err.message }, { status });
    }
    return NextResponse.json({ ok: false, error: "Couldn't verify that account with Anthropic." }, { status: 502 });
  }

  // 2) Claim the code (transactional, single-use). The claim publishes "processing", never "done",
  //    so the polling browser cannot report success before the vault save below has completed.
  let claim: Awaited<ReturnType<typeof claimPairing>>;
  try {
    claim = await claimPairing(code, Date.now());
  } catch (error) {
    const { errorId } = reportServerError("connect.pair.claim", error);
    return NextResponse.json(
      { ok: false, error: "Couldn't complete pairing — try again.", errorId },
      { status: 500 },
    );
  }
  if (!claim.ok) {
    const messages: Record<string, [number, string]> = {
      not_found: [404, "That pairing code isn't valid. Open the app and start again to get a fresh code."],
      processing: [409, "That pairing code is already being completed. Check the app for its status."],
      done: [409, "That pairing code was already used. Start again in the app to get a fresh one."],
      failed: [409, "That pairing attempt failed. Start again in the app to get a fresh code."],
      expired: [410, "That pairing code expired. Start again in the app to get a fresh one."],
    };
    const [status, message] = messages[claim.reason] ?? [400, "That pairing code can't be used."];
    return NextResponse.json({ ok: false, error: message }, { status });
  }

  // Reconnect pairings are account-scoped. The code owner chose a specific existing account, so a
  // helper running under a different Claude login must never overwrite/add that other identity.
  // Reject after the single-use claim but before any vault write, then publish a safe terminal error
  // for the owner's polling UI. Neither account id is reflected in the public response.
  if (!pairingAccountMatches(claim.expectedAccountId, profile.account?.uuid)) {
    const error = "Claude Code is signed into a different account than the one being reconnected.";
    await finalizePairing(code, { status: "failed", error }).catch((finalizeError) => {
      reportServerError("connect.pair.finalize", finalizeError);
    });
    return NextResponse.json({ ok: false, error }, { status: 409 });
  }

  // 3) Add the resolved account to the code owner's vault (dedupe by account id), then and only then
  //    finalize the pairing as done. Save failures become a terminal failed state carrying a message
  //    safe for the code owner's status response; tokens and internal exception details are never stored.
  let saveErrorId: string | undefined;
  let finalizeErrorId: string | undefined;
  const outcome = await saveThenFinalizePairing({
    save: () => saveResolvedAccount(claim.userId, profile, resolvedTokens),
    emailOf: (info) => info.email,
    finalize: async (result) => {
      try {
        const finalized = await finalizePairing(code, result);
        if (!finalized) {
          finalizeErrorId = reportServerError("connect.pair.finalize", new Error()).errorId;
        }
        return finalized;
      } catch (error) {
        finalizeErrorId = reportServerError("connect.pair.finalize", error).errorId;
        throw error;
      }
    },
    classifySaveError: (err) => {
      saveErrorId = reportServerError("connect.pair.save", err).errorId;
      return { status: 500, error: "Couldn't save the connected account. Start again with a fresh code." };
    },
  });
  if (!outcome.ok) {
    const errorId = saveErrorId ?? finalizeErrorId;
    return NextResponse.json(
      { ok: false, error: outcome.error, ...(errorId ? { errorId } : {}) },
      { status: outcome.status },
    );
  }
  return NextResponse.json({ ok: true, email: outcome.value.email });
}
