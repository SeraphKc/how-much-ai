// The open-source edition is a single-tenant self-hosted app. Storage helpers still use an
// explicit tenant id internally so existing encrypted vaults and optional Convex/Redis backends
// remain compatible with earlier releases.

// Namespace a storage key for a tenant. The self-hosted tenant intentionally keeps the historical
// bare key so existing vaults continue to load without migration.
export function scopedKey(base: string, userId: string): string {
  return userId === "default" ? base : `${base}::${userId}`;
}
