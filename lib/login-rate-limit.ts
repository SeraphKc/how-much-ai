import { isIP } from "node:net";

export const LOGIN_RATE_LIMIT_DEFAULTS = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  maxEntries: 10_000,
} as const;

export interface LoginRateLimitStatus {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface LoginRateLimiter {
  check(key: string, now?: number): LoginRateLimitStatus;
  recordFailure(key: string, now?: number): LoginRateLimitStatus;
  reset(key: string): void;
}

interface Entry {
  failures: number;
  resetAt: number;
}

interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  maxEntries?: number;
}

const OVERFLOW_KEY = "__overflow__";

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// A small, dependency-free fixed-window limiter for the password gate. The bounds deliberately
// fail closed: invalid options fall back to safe values, missing client IPs share one bucket, and
// IP-cardinality overflow shares a bucket rather than growing memory without limit.
export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const maxFailures = positiveInt(options.maxFailures, LOGIN_RATE_LIMIT_DEFAULTS.maxFailures);
  const windowMs = positiveInt(options.windowMs, LOGIN_RATE_LIMIT_DEFAULTS.windowMs);
  const maxEntries = positiveInt(options.maxEntries, LOGIN_RATE_LIMIT_DEFAULTS.maxEntries);
  const entries = new Map<string, Entry>();

  function liveEntry(key: string, now: number): Entry | undefined {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= now) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function pruneExpired(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  function storageKey(key: string, now: number): string {
    if (entries.has(key)) return key;
    if (entries.size >= maxEntries - 1) pruneExpired(now);
    // Reserve one of the bounded slots for overflow. With maxEntries=1 every client shares that
    // single bucket; with the production default, 9,999 IPs remain independently tracked.
    const directEntries = entries.size - (entries.has(OVERFLOW_KEY) ? 1 : 0);
    return directEntries < maxEntries - 1 ? key : OVERFLOW_KEY;
  }

  function status(entry: Entry | undefined, now: number): LoginRateLimitStatus {
    const failures = entry?.failures ?? 0;
    return {
      allowed: failures < maxFailures,
      remaining: Math.max(0, maxFailures - failures),
      retryAfterSeconds: entry && failures >= maxFailures ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0,
    };
  }

  return {
    check(key, now = Date.now()) {
      const bucket = entries.has(key) ? key : entries.has(OVERFLOW_KEY) ? OVERFLOW_KEY : key;
      return status(liveEntry(bucket, now), now);
    },

    recordFailure(key, now = Date.now()) {
      const bucket = storageKey(key, now);
      const entry = liveEntry(bucket, now) ?? { failures: 0, resetAt: now + windowMs };
      entry.failures++;
      entries.set(bucket, entry);
      return status(entry, now);
    },

    reset(key) {
      entries.delete(key);
    },
  };
}

function normalizedIp(value: string | null): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate) return null;

  // Some reverse proxies include a port. Bracketed IPv6 and IPv4:port are unambiguous; an
  // unbracketed IPv6 address is left intact.
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) candidate = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) candidate = candidate.slice(0, candidate.lastIndexOf(":"));

  return isIP(candidate) ? candidate.toLowerCase() : null;
}

// These headers are only trustworthy when the deployment's reverse proxy overwrites them. Invalid
// or absent values intentionally collapse to one "unknown" bucket so a missing header cannot bypass
// throttling. x-forwarded-for's first hop is the original client on the supported hosting setups.
export function loginClientKey(headers: Pick<Headers, "get">, trustProxyHeaders = true): string {
  if (!trustProxyHeaders) return "unknown";
  const direct = ["cf-connecting-ip", "fly-client-ip", "x-real-ip"];
  for (const name of direct) {
    const ip = normalizedIp(headers.get(name));
    if (ip) return ip;
  }

  const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0] ?? null;
  return normalizedIp(forwarded) ?? "unknown";
}

export function trustedLoginProxyHeaders(): boolean {
  return (
    process.env.TRUST_PROXY_IP_HEADERS === "1" ||
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.CF_PAGES) ||
    Boolean(process.env.FLY_APP_NAME)
  );
}
