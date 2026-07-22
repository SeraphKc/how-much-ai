import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildPairingCommand } from "@/lib/connect-url.mjs";
import { generatePairingCode, normalizePairingCode } from "@/lib/pairing-core";
import { createPairing, pairingBackendAvailable } from "@/lib/pairings-store";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

// Node runtime: talks to Convex (the shared pairing store).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start a pairing: the signed-in user gets a fresh single-use code (10-min TTL) plus the command to run.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  if (!pairingBackendAvailable()) {
    return NextResponse.json(
      { error: "Pairing isn't available on this deployment (needs a Convex backend)." },
      { status: 501 },
    );
  }

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" ||
      !body.expectedAccountId.trim() ||
      body.expectedAccountId.length > 200)
  ) {
    return NextResponse.json({ error: "Invalid expected account id" }, { status: 400 });
  }
  const expectedAccountId =
    typeof body.expectedAccountId === "string" && body.expectedAccountId.trim()
      ? body.expectedAccountId.trim()
      : undefined;

  const code = generatePairingCode(); // grouped for display, e.g. ABCD-EFGH-JKLM
  let command: string;
  try {
    command = buildPairingCommand(code, process.env.APP_URL || new URL(req.url).origin);
  } catch {
    return NextResponse.json(
      { error: "Pairing needs APP_URL set to this app's HTTPS origin (or a loopback development URL)." },
      { status: 503 },
    );
  }
  const bare = normalizePairingCode(code); // stored + looked up in bare form
  try {
    await createPairing(bare, userId, Date.now(), expectedAccountId);
  } catch {
    return NextResponse.json({ error: "Couldn't start pairing. Wait a moment and try again." }, { status: 503 });
  }

  return NextResponse.json({ code, command });
}
