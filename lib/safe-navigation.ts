const APP_ORIGIN = "https://internal.invalid";

/**
 * Return a same-app path that is safe to hand to client-side navigation.
 *
 * A leading slash alone is not enough: browsers interpret protocol-relative
 * paths (`//example.com`) and backslashes as authority separators. Encoded
 * separators in the pathname are rejected too so a later decode cannot turn
 * an accepted path into an external destination; query values may contain
 * encoded paths without changing the navigation origin.
 */
export function safeInternalPath(candidate: string | null | undefined): string {
  if (!candidate || candidate !== candidate.trim()) return "/";
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  const pathOnly = candidate.split(/[?#]/, 1)[0];
  if (pathOnly.includes("\\") || /%(?:2f|5c)/i.test(pathOnly)) return "/";
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return "/";

  try {
    const parsed = new URL(candidate, APP_ORIGIN);
    if (parsed.origin !== APP_ORIGIN || !parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}
