// Server-side access to the notification tables in Convex (config, detector state, push subs).
// Mirrors the Convex path in lib/vault.ts and shares its VAULT_ACCESS_SECRET. Notifications are
// a Convex-backed feature: the scheduler is a Convex cron, and subscriptions/state need a shared
// DB across the app's serverless invocations. When Convex isn't configured, the whole feature is
// simply unavailable (the dashboard itself still runs file-only with zero config).
//
// The self-hosted HTTP boundary always supplies the stable `default` tenant. The parameter remains
// explicit so storage keys and historical rows stay compatible across upgrades.

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { NotifyState, NotifyThresholds, NotifyToggles } from "./notify-detect";

export const NOTIFICATION_STORAGE_TIMEOUT_MS = 15_000;

export type NotifyConfig = NotifyToggles & NotifyThresholds;

export interface StoredNotifyState extends NotifyState {
  key: string; // `${accountId}::${limitKey}`
  accountId: string;
  limitKey: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function convexConfig(): { url: string; secret: string } | null {
  const url = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.VAULT_ACCESS_SECRET;
  return url && secret ? { url, secret } : null;
}

// True when the Convex backend needed for notifications is configured.
export function notifyStorageReady(): boolean {
  return convexConfig() !== null;
}

function client(): { c: ConvexHttpClient; secret: string } {
  const cx = convexConfig();
  if (!cx) {
    throw new Error("Notifications require Convex — set CONVEX_URL and VAULT_ACCESS_SECRET");
  }
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(NOTIFICATION_STORAGE_TIMEOUT_MS) });
  return { c: new ConvexHttpClient(cx.url, { fetch: timedFetch }), secret: cx.secret };
}

export interface NotificationRunClaim {
  acquired: boolean;
  leaseUntil: number;
}

export async function claimNotificationRun(userId: string, owner: string): Promise<NotificationRunClaim> {
  const { c, secret } = client();
  return (await c.mutation(anyApi.notify.claimRun, { secret, userId, owner })) as NotificationRunClaim;
}

export async function renewNotificationRun(userId: string, owner: string): Promise<boolean> {
  const { c, secret } = client();
  return (await c.mutation(anyApi.notify.renewRun, { secret, userId, owner })) as boolean;
}

export async function releaseNotificationRun(userId: string, owner: string): Promise<boolean> {
  const { c, secret } = client();
  return (await c.mutation(anyApi.notify.releaseRun, { secret, userId, owner })) as boolean;
}

export async function loadConfig(userId: string): Promise<NotifyConfig> {
  const { c, secret } = client();
  return (await c.query(anyApi.notify.getConfig, { secret, userId })) as NotifyConfig;
}

export async function saveConfig(userId: string, cfg: NotifyConfig): Promise<void> {
  const { c, secret } = client();
  await c.mutation(anyApi.notify.setConfig, { secret, userId, ...cfg });
}

export async function loadStates(userId: string): Promise<StoredNotifyState[]> {
  const { c, secret } = client();
  return (await c.query(anyApi.notify.getStates, { secret, userId })) as StoredNotifyState[];
}

export async function saveStates(userId: string, states: StoredNotifyState[]): Promise<void> {
  const { c, secret } = client();
  // Full-snapshot replacement. Passing [] intentionally removes stale detector rows for a tenant.
  await c.mutation(anyApi.notify.putStates, { secret, userId, states });
}

export async function loadSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  const { c, secret } = client();
  return (await c.query(anyApi.notify.listSubscriptions, { secret, userId })) as PushSubscriptionRecord[];
}

export async function addSubscription(userId: string, sub: PushSubscriptionRecord): Promise<void> {
  const { c, secret } = client();
  await c.mutation(anyApi.notify.addSubscription, { secret, userId, ...sub });
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  const { c, secret } = client();
  await c.mutation(anyApi.notify.removeSubscription, { secret, userId, endpoint });
}
