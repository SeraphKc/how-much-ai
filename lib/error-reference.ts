const SERVER_ERROR_ID_PATTERN = /^err_[a-f0-9]{12}$/;

export function safeServerErrorId(value: unknown): string | undefined {
  return typeof value === "string" && SERVER_ERROR_ID_PATTERN.test(value) ? value : undefined;
}

// API failures may include an opaque correlation id. Reflect only the exact server-generated shape
// so a malformed or attacker-controlled response cannot add arbitrary text to the UI.
export function serverErrorText(error: unknown, fallback: string, errorId?: unknown): string {
  const message = typeof error === "string" && error.trim() ? error.trim() : fallback;
  const safeErrorId = safeServerErrorId(errorId);
  if (!safeErrorId) return message;
  const separator = /[.!?]$/.test(message) ? "" : ".";
  return `${message}${separator} Reference: ${safeErrorId}.`;
}
