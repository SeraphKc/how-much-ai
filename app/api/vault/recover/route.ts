import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  recoverUnreadableLocalVault,
  VAULT_RECOVERY_CONFIRMATION,
  VaultRecoveryError,
} from "@/lib/vault";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isExactConfirmation(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    Object.prototype.hasOwnProperty.call(body, "confirmation") &&
    body.confirmation === VAULT_RECOVERY_CONFIRMATION
  );
}

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  if (!isExactConfirmation(body)) {
    return NextResponse.json(
      { error: `Type the exact recovery confirmation: ${VAULT_RECOVERY_CONFIRMATION}` },
      { status: 400 },
    );
  }

  try {
    const { archive, backupArchive } = await recoverUnreadableLocalVault(userId);
    return NextResponse.json({
      ok: true,
      archive,
      ...(backupArchive ? { backupArchive } : {}),
    });
  } catch (error) {
    if (error instanceof VaultRecoveryError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "Couldn't safely archive the unreadable local vault. It was left untouched." },
      { status: 500 },
    );
  }
}
