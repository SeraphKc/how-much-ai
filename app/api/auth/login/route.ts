import { NextResponse } from "next/server";
import { appPassword, createSession, safeEqual, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/session";
import {
  createLoginRateLimiter,
  loginClientKey,
  trustedLoginProxyHeaders,
  type LoginRateLimiter,
} from "@/lib/login-rate-limit";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

export const runtime = "nodejs";

declare global {
  var __hmcLoginRateLimiter: LoginRateLimiter | undefined;
}

// This is intentionally a safe zero-config baseline, not a distributed guarantee. The global keeps
// state across hot reloads and warm requests in one Node process; multi-instance/serverless deploys
// should add a shared edge/WAF/Redis limit too because each process has its own in-memory bucket.
const limiter = globalThis.__hmcLoginRateLimiter ?? createLoginRateLimiter();
globalThis.__hmcLoginRateLimiter = limiter;

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const expected = appPassword();
  if (!expected) {
    return NextResponse.json(
      { error: "This instance has no password set. Set the APP_PASSWORD environment variable." },
      { status: 503 },
    );
  }

  const clientKey = loginClientKey(req.headers, trustedLoginProxyHeaders());
  const rate = limiter.check(clientKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    limiter.recordFailure(clientKey);
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  const password = typeof body.password === "string" ? body.password : "";

  if (!password || !safeEqual(password, expected)) {
    limiter.recordFailure(clientKey);
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  limiter.reset(clientKey);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
