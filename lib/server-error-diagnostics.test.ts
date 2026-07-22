import test from "node:test";
import assert from "node:assert/strict";
import { reportServerError } from "./server-error-diagnostics.ts";

test("server diagnostics log only an opaque id and allowlisted classification", () => {
  const originalError = console.error;
  const captured: unknown[][] = [];
  const secret = "sk-ant-fake-secret-in-error-message";
  const failure = Object.assign(new Error(`vault failed for ${secret}`), {
    code: "SECRET_CODE_MUST_NOT_LEAK",
    cause: new Error(`nested ${secret}`),
    userId: `user-${secret}`,
    ciphertext: `cipher-${secret}`,
  });
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const result = reportServerError("vault.read", failure);
    assert.match(result.errorId, /^err_[a-f0-9]{12}$/);
    assert.deepEqual(captured, [
      [
        {
          errorId: result.errorId,
          scope: "vault.read",
          errorClass: "Error",
          code: "UNKNOWN",
        },
      ],
    ]);
    const serialized = JSON.stringify({ result, captured });
    for (const forbidden of [secret, failure.message, "cause", "userId", "ciphertext", "SECRET_CODE_MUST_NOT_LEAK"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    console.error = originalError;
  }
});

test("server diagnostics expose only explicitly allowlisted operational codes", () => {
  const originalError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    reportServerError("vault.mutate", Object.assign(new Error("private path"), { code: "ENOTDIR" }));
    assert.equal((captured[0][0] as { code: string }).code, "ENOTDIR");
  } finally {
    console.error = originalError;
  }
});

test("server diagnostics preserve the safe vault-key mismatch class without its message", () => {
  const originalError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    class VaultEncryptionKeyMismatchError extends Error {}
    const failure = new VaultEncryptionKeyMismatchError("private mismatch detail");
    reportServerError("vault.read", failure);
    assert.equal((captured[0][0] as { errorClass: string }).errorClass, "VaultEncryptionKeyMismatchError");
    assert.equal(JSON.stringify(captured).includes("private mismatch detail"), false);
  } finally {
    console.error = originalError;
  }
});
