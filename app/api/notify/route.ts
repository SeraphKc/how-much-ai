import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadConfig, notifyStorageReady, saveConfig, type NotifyConfig } from "@/lib/notify-store";
import { pushConfig } from "@/lib/notify";
import { parseNotifyConfig } from "@/lib/notify-config";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ready = notifyStorageReady();
  const push = pushConfig();
  const base = { ready, pushConfigured: !!push, vapidPublicKey: push?.publicKey ?? null };
  if (!ready) return NextResponse.json({ ...base, config: null });
  try {
    return NextResponse.json({ ...base, config: await loadConfig(userId) });
  } catch (err) {
    return NextResponse.json(
      { ...base, config: null, error: err instanceof Error ? err.message : "Couldn't load settings" },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!notifyStorageReady()) {
    return NextResponse.json({ error: "Notifications need Convex — see .env.example" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 16 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  const parsed = parseNotifyConfig(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const config: NotifyConfig = parsed.config;
  try {
    await saveConfig(userId, config);
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save settings" },
      { status: 500 },
    );
  }
}
