import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { browserMutationFailure } from "@/lib/request-body";

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
