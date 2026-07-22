import crypto from "node:crypto";

export type ServerErrorScope =
  | "connect.oauth.save"
  | "connect.manual.save"
  | "connect.pair.preflight"
  | "connect.pair.claim"
  | "connect.pair.save"
  | "connect.pair.finalize"
  | "vault.read"
  | "vault.mutate";

const SAFE_ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "ConvexError",
  "StorageConfigurationError",
  "VaultEncryptionKeyMismatchError",
  "VaultValidationError",
]);

const SAFE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "EACCES",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EIO",
  "EISDIR",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTFOUND",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
  "ERR_INVALID_ARG_TYPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  const name = error.constructor?.name;
  return typeof name === "string" && SAFE_ERROR_CLASSES.has(name) ? name : "Error";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODES.has(code) ? code : "UNKNOWN";
}

// Production incidents need a correlation handle, never the exception itself. Keep this record
// deliberately closed: no message, stack, cause, tenant/account id, credential, request body, or
// ciphertext may be added here.
export function reportServerError(scope: ServerErrorScope, error: unknown): { errorId: string } {
  const errorId = `err_${crypto.randomBytes(6).toString("hex")}`;
  console.error({
    errorId,
    scope,
    errorClass: errorClass(error),
    code: errorCode(error),
  });
  return { errorId };
}
