import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { addSubscription, notifyStorageReady, removeSubscription } from "@/lib/notify-store";
import { isSafePushEndpoint } from "@/lib/notify-safety";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The browser's PushSubscription.toJSON() shape: { endpoint, keys: { p256dh, auth } }.
function parseSubscription(body: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const endpoint = b.endpoint;
  const keys = (b.keys ?? {}) as Record<string, unknown>;
  if (typeof endpoint !== "string" || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return null;
  }
  const encodedKey = /^[A-Za-z0-9_-]+={0,2}$/;
  if (
    endpoint.length > 2_048 ||
    keys.p256dh.length < 16 ||
    keys.p256dh.length > 512 ||
    keys.auth.length < 8 ||
    keys.auth.length > 256 ||
    !encodedKey.test(keys.p256dh) ||
    !encodedKey.test(keys.auth) ||
    !isSafePushEndpoint(endpoint)
  ) {
    return null;
  }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!notifyStorageReady()) {
    return NextResponse.json({ error: "Notifications need Convex — see .env.example" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 8 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  const sub = parseSubscription(body);
  if (!sub) return NextResponse.json({ error: "Malformed or unsafe subscription" }, { status: 400 });
  try {
    await addSubscription(userId, sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't save" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!notifyStorageReady()) return NextResponse.json({ ok: true }); // nothing to remove
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 2_048 || !isSafePushEndpoint(endpoint)) {
    return NextResponse.json({ error: "Missing or unsafe endpoint" }, { status: 400 });
  }
  try {
    await removeSubscription(userId, endpoint);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't remove" }, { status: 500 });
  }
}
