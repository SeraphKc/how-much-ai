import { isIP } from "node:net";

const MAX_PUSH_ENDPOINT_LENGTH = 2_048;

function ipv4Number(host: string): number | null {
  if (isIP(host) !== 4) return null;
  const parts = host.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function inIpv4Cidr(ip: number, network: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (network & mask);
}

const UNSAFE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // current host / unspecified
  [0x0a000000, 8], // RFC1918
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // RFC1918
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // TEST-NET-1
  [0xc01fC400, 24], // AS112-v4
  [0xc034c100, 24], // AMT
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // RFC1918
  [0xc0af3000, 24], // AS112 direct delegation
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved + limited broadcast
];

function isUnsafeIpv4(host: string): boolean {
  const ip = ipv4Number(host);
  return ip !== null && UNSAFE_IPV4_RANGES.some(([network, bits]) => inIpv4Cidr(ip, network, bits));
}

function ipv6Bytes(host: string): Uint8Array | null {
  if (isIP(host) !== 6) return null;
  const halves = host.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    const value = Number.parseInt(groups[i], 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >>> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function bytesInCidr(bytes: Uint8Array, network: readonly number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  const partial = bits % 8;
  for (let i = 0; i < whole; i++) {
    if (bytes[i] !== (network[i] ?? 0)) return false;
  }
  if (!partial) return true;
  const mask = (0xff << (8 - partial)) & 0xff;
  return (bytes[whole] & mask) === ((network[whole] ?? 0) & mask);
}

const UNSAFE_IPV6_RANGES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x00], 8], // unspecified, loopback and other reserved forms (mapped IPv4 handled first)
  [[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64], // discard-only
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48], // private-use NAT64
  [[0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48], // benchmarking
  [[0x20, 0x01, 0x00, 0x10], 28], // ORCHID (deprecated)
  [[0x20, 0x01, 0x00, 0x20], 28], // ORCHIDv2
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x3f, 0xff, 0x00], 20], // documentation
  [[0x5f, 0x00], 16], // segment-routing SIDs
  [[0xfc], 7], // unique-local
  [[0xfe, 0x80], 9], // link-local + deprecated site-local half
  [[0xff], 8], // multicast
];

function embeddedIpv4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isUnsafeIpv6(host: string): boolean {
  const bytes = ipv6Bytes(host);
  if (!bytes) return false;

  // IPv4-mapped IPv6, well-known NAT64, and 6to4 can still address an IPv4-only internal target.
  const mapped = bytes.slice(0, 10).every((part) => part === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isUnsafeIpv4(embeddedIpv4(bytes, 12));
  const nat64 = bytesInCidr(bytes, [0x00, 0x64, 0xff, 0x9b], 96);
  if (nat64) return isUnsafeIpv4(embeddedIpv4(bytes, 12));
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isUnsafeIpv4(embeddedIpv4(bytes, 2));

  return UNSAFE_IPV6_RANGES.some(([network, bits]) => bytesInCidr(bytes, network, bits));
}

const PRIVATE_HOST_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home",
  "lan",
  "corp",
  "home.arpa",
  "invalid",
  "test",
  "example",
  "svc",
  "cluster.local",
] as const;

function normalizeHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function isUnsafeHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isUnsafeIpv4(host);
  if (ipVersion === 6) return isUnsafeIpv6(host);
  if (!host.includes(".")) return true; // single-label names resolve through private search domains
  return PRIVATE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Syntactic SSRF guard for browser push subscriptions. This intentionally rejects obvious local,
// private and special-use targets without making a DNS request during an authenticated API call.
// Delivery-time validation repeats the check for legacy rows. DNS resolution/rebinding still needs
// an outbound proxy or network egress policy for complete protection.
export function isSafePushEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    return !!url.hostname && !isUnsafeHostname(url.hostname);
  } catch {
    return false;
  }
}

// TELEGRAM_* and WEBHOOK_URL are deployment-wide secrets/destinations, so they belong only to the
// stable self-hosted tenant. Web Push subscriptions are stored with that same tenant boundary.
export function canUseGlobalNotificationChannels(userId: string): boolean {
  return userId === "default";
}
