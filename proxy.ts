import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authOpen, verifySession } from "@/lib/session";

// These endpoints authenticate themselves or must be reachable before a password session exists.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/cron/check",
  // Called by the command-line pairing helper, which has no browser cookie. The route requires a
  // random, single-use, ten-minute pairing code and applies a bounded rate limit.
  "/api/connect/pair/complete",
  "/icon.svg",
  "/sw.js",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function bounceToLogin(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (authOpen()) {
    if (pathname === "/login") {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (isPublic(pathname)) return NextResponse.next();
  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return bounceToLogin(req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
