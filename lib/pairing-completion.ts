// Dependency-injected orchestration for the post-claim pairing phase. The route supplies the vault
// save and Convex finalizer, which lets tests prove observable ordering without mocking Next or Convex.

export type PairingFinalizationPayload =
  | { status: "done"; email: string }
  | { status: "failed"; error: string };

export interface PairingHttpFailure {
  status: 402 | 500;
  error: string;
}

export type PairingPersistenceOutcome<T> =
  | { ok: true; value: T }
  | ({ ok: false; saved: boolean } & PairingHttpFailure);

export const PAIRING_CONFIRMATION_ERROR =
  "The account was saved, but pairing confirmation failed. Refresh the app to check your accounts.";

export function pairingAccountMatches(expectedAccountId: string | undefined, resolvedAccountId: string | undefined): boolean {
  return !expectedAccountId || resolvedAccountId === expectedAccountId;
}

export async function saveThenFinalizePairing<T>({
  save,
  emailOf,
  finalize,
  classifySaveError,
}: {
  save: () => Promise<T>;
  emailOf: (value: T) => string;
  finalize: (result: PairingFinalizationPayload) => Promise<boolean>;
  classifySaveError: (error: unknown) => PairingHttpFailure;
}): Promise<PairingPersistenceOutcome<T>> {
  let value: T;
  try {
    value = await save();
  } catch (error) {
    const failure = classifySaveError(error);
    try {
      await finalize({ status: "failed", error: failure.error });
    } catch {
      // The request remains failed and the pairing remains processing; it can never false-succeed.
    }
    return { ok: false, saved: false, ...failure };
  }

  try {
    const finalized = await finalize({ status: "done", email: emailOf(value) });
    if (!finalized) return { ok: false, saved: true, status: 500, error: PAIRING_CONFIRMATION_ERROR };
  } catch {
    return { ok: false, saved: true, status: 500, error: PAIRING_CONFIRMATION_ERROR };
  }

  return { ok: true, value };
}
