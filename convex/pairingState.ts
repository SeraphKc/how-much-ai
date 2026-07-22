// Pure decision logic used by the transactional Convex claim mutation. It lives beside the mutation
// so the deployed backend and unit tests exercise the same state/TTL rules.

export const PAIRING_TTL_MS = 10 * 60_000;
// The post-claim work is one vault mutation plus one Convex mutation and normally takes seconds. A
// two-minute lease prevents a crashed serverless invocation from leaving the owner's UI spinning
// forever, while deliberately never making the code reusable (stale processing becomes failed).
export const PAIRING_PROCESSING_TIMEOUT_MS = 2 * 60_000;
export const STALE_PAIRING_ERROR =
  "Pairing timed out before it could be confirmed. Refresh your accounts before trying again.";

export type PairingClaimRejection = "not_found" | "processing" | "done" | "failed" | "expired";

export type PairingClaimDecision =
  | { ok: true }
  | { ok: false; reason: PairingClaimRejection; transition: "expired" | "failed" | null };

export function decidePairingClaim(
  row: { status: string; createdAt: number; processingAt?: number } | null,
  now: number,
  ttlMs = PAIRING_TTL_MS,
  processingTimeoutMs = PAIRING_PROCESSING_TIMEOUT_MS,
): PairingClaimDecision {
  if (!row) return { ok: false, reason: "not_found", transition: null };
  if (row.status === "processing") {
    const processingAt = Number.isFinite(row.processingAt) ? row.processingAt! : row.createdAt;
    return now - processingAt >= processingTimeoutMs
      ? { ok: false, reason: "failed", transition: "failed" }
      : { ok: false, reason: "processing", transition: null };
  }
  if (row.status === "done") return { ok: false, reason: "done", transition: null };
  if (row.status === "failed") return { ok: false, reason: "failed", transition: null };
  if (row.status === "expired") return { ok: false, reason: "expired", transition: null };

  // Unknown/legacy states fail closed so they can never be reclaimed and double-saved.
  if (row.status !== "pending") return { ok: false, reason: "failed", transition: null };
  if (now - row.createdAt >= ttlMs) return { ok: false, reason: "expired", transition: "expired" };
  return { ok: true };
}

// Retention predicate used when a tenant reaches the pairing-record cap. Pending and processing
// rows remain until their respective leases expire; terminal and unknown fail-closed rows may be
// reclaimed. Keeping this pure makes the database cleanup rule directly testable.
export function pairingRecordReclaimable(
  row: { status: string; createdAt: number; processingAt?: number },
  now: number,
  ttlMs = PAIRING_TTL_MS,
  processingTimeoutMs = PAIRING_PROCESSING_TIMEOUT_MS,
): boolean {
  if (row.status === "pending") return now - row.createdAt >= ttlMs;
  if (row.status === "processing") {
    const processingAt = Number.isFinite(row.processingAt) ? row.processingAt! : row.createdAt;
    return now - processingAt >= processingTimeoutMs;
  }
  return true;
}
