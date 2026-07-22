import { createHash } from "node:crypto";

export const NOTIFICATION_DELIVERY_TIMEOUT_MS = 10_000;

export interface NotificationIdempotencyEvent {
  accountId?: string;
  accountLabel: string;
  event: { type: string; limitKey: string; resetsAt: string | null };
}

export function notificationBatchId(userId: string, events: readonly NotificationIdempotencyEvent[]): string {
  // Percent/peak values can change between an at-least-once retry. The transition identity does
  // not: tenant + account + event type + limit + reset window remains stable until state commits.
  const transitions = events.map(({ accountId, accountLabel, event }) => ({
    account: accountId || accountLabel,
    type: event.type,
    limitKey: event.limitKey,
    resetsAt: event.resetsAt,
  }));
  const digest = createHash("sha256").update(JSON.stringify({ userId, transitions })).digest("hex");
  return `notification-${digest}`;
}

export function notificationFetchOptions(init: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(NOTIFICATION_DELIVERY_TIMEOUT_MS) };
}

export function notificationWebPushOptions(): { timeout: number } {
  return { timeout: NOTIFICATION_DELIVERY_TIMEOUT_MS };
}
