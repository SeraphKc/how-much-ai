// Password-gate session token. Uses Web Crypto (HMAC-SHA256) so it works in both the
// Node route handlers and the Edge/Node middleware. The token is just a signed expiry —
// there's one user (whoever knows APP_PASSWORD), so there's no per-user state to carry.

export const SESSION_COOKIE = "usage_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const encoder = new TextEncoder();

// Web Crypto wants an ArrayBuffer-backed view; TS's newer lib types are picky about the
// Uint8Array generic, so normalize through a plain ArrayBuffer.
function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// The secret that signs sessions. Defaults to APP_PASSWORD so there's one thing to configure;
// set AUTH_SECRET separately if you want sessions to survive a password change.
export function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}

export function appPassword(): string | undefined {
  const pw = process.env.APP_PASSWORD;
  return pw && pw.length > 0 ? pw : undefined;
}

// The zero-config local default: no APP_PASSWORD runs the app fully OPEN. This is what makes
// "clone, npm run dev, done" work with no setup. It is ONLY safe on your own machine or a trusted
// network; set APP_PASSWORD before exposing the app publicly.
export function authOpen(): boolean {
  // A leftover hosted-mode variable must never turn into an accidentally open deployment after an
  // upgrade to the self-hosted edition. Unsupported legacy values fail closed at the login gate.
  const legacyMode = process.env.AUTH_MODE?.trim();
  if (legacyMode && legacyMode !== "password") return false;
  return !appPassword();
}

// Constant-time string comparison to avoid leaking the password via timing.
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function createSession(now: number = Date.now()): Promise<string> {
  const secret = authSecret();
  if (!secret) throw new Error("APP_PASSWORD is not configured");
  const payload = b64urlEncode(encoder.encode(JSON.stringify({ exp: now + SESSION_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), buf(encoder.encode(payload)));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(token: string | undefined, now: number = Date.now()): Promise<boolean> {
  const secret = authSecret();
  if (!secret || !token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), buf(b64urlDecode(sig)), buf(encoder.encode(payload)));
    if (!valid) return false;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return typeof data.exp === "number" && data.exp > now;
  } catch {
    return false;
  }
}
