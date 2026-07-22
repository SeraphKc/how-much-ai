import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { isExpired, normalizePairingCode, PAIRING_CODE_LENGTH } from "@/lib/pairing-core";
import { getPairing, pairingBackendAvailable } from "@/lib/pairings-store";

// Node runtime: talks to Convex.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The browser polls this while showing the pairing command. Owner-only: a signed-in user can only see
// the status of a code THEY created — so no one can watch someone else's pairing. Returns a whitelisted
// public projection of pending | processing | done | failed | expired, exposing email only after a
// successful save and exposing only the deliberately public-safe error recorded by finalization.
export async function GET(req: Request) {
  if (!pairingBackendAvailable()) {
    return NextResponse.json({ error: "Pairing isn't available on this deployment." }, { status: 501 });
  }

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const rawCode = new URL(req.url).searchParams.get("code") ?? "";
  const code = rawCode.length <= 64 ? normalizePairingCode(rawCode) : "";
  if (code.length !== PAIRING_CODE_LENGTH) {
    return NextResponse.json({ error: "Missing or malformed pairing code" }, { status: 400 });
  }

  let row: Awaited<ReturnType<typeof getPairing>>;
  try {
    row = await getPairing(code);
  } catch {
    return NextResponse.json({ error: "Couldn't check pairing status." }, { status: 500 });
  }
  // Unknown code → treat as no-longer-valid so the UI stops waiting.
  if (!row) return NextResponse.json({ status: "expired" });
  // Owner-only: never reveal another user's pairing state.
  if (row.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (row.status === "pending") {
    return NextResponse.json({ status: isExpired(row.createdAt, Date.now()) ? "expired" : "pending" });
  }
  if (row.status === "processing") return NextResponse.json({ status: "processing" });
  if (row.status === "done") {
    return NextResponse.json({ status: "done", ...(row.email ? { email: row.email } : {}) });
  }
  if (row.status === "failed") {
    return NextResponse.json({
      status: "failed",
      error: row.error || "Couldn't save the connected account. Start again with a fresh code.",
    });
  }
  // Includes explicitly expired rows and any unknown legacy/corrupt state. Do not reflect arbitrary
  // stored status strings to the browser.
  return NextResponse.json({ status: "expired" });
}
