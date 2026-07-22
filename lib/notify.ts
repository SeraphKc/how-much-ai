// Notification dispatcher. Takes the detector's events and fans them out to configured channels:
// deployment-global Telegram/webhook only for the shared default tenant, plus tenant-scoped Web
// Push. Each channel is independent: a failure in one never blocks the others, but failures and
// per-event delivery coverage are returned to the caller. The cron uses that coverage to avoid
// advancing detector state for an alert that did not reach any destination.

import type { NotifyEvent } from "./notify-detect";
import { loadSubscriptions, removeSubscription } from "./notify-store";
import { canUseGlobalNotificationChannels, isSafePushEndpoint } from "./notify-safety";
import {
  notificationBatchId,
  notificationFetchOptions,
  notificationWebPushOptions,
} from "./notify-transport";

export { notificationBatchId, NOTIFICATION_DELIVERY_TIMEOUT_MS } from "./notify-transport";

export interface AccountEvent {
  event: NotifyEvent;
  accountLabel: string; // nickname or email — who this is about
  accountId?: string; // stable identity used for webhook idempotency; label is the legacy fallback
}

const round = (n: number) => Math.round(n);

// The human-facing line for an event (self-contained: emoji + who + detail).
export function eventBody({ event, accountLabel }: AccountEvent): string {
  const who = accountLabel;
  const l = event.limitLabel;
  switch (event.type) {
    case "recovery":
      return `♻️ ${who}: ${l} reset — peaked ${round(event.peakPct)}%, now ${round(event.percent)}%. You're clear to keep going.`;
    case "warning":
      return `⚠️ ${who}: ${l} at ${round(event.percent)}% — approaching the limit.`;
    case "every_reset":
      return `🔄 ${who}: ${l} reset (now ${round(event.percent)}%).`;
  }
}

function eventTitle(type: NotifyEvent["type"]): string {
  switch (type) {
    case "recovery":
      return "Limit reset — you're clear";
    case "warning":
      return "Approaching a limit";
    case "every_reset":
      return "Limit reset";
  }
}

// --- channel: Telegram --------------------------------------------------------

function telegramConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}

interface ChannelOutcome {
  channel: "telegram" | "webhook" | "push";
  attempted: boolean;
  deliveredIndexes: number[];
  failures: string[];
}

const allIndexes = (length: number) => Array.from({ length }, (_, index) => index);

async function sendTelegram(text: string, eventCount: number): Promise<ChannelOutcome> {
  const cfg = telegramConfig();
  if (!cfg) return { channel: "telegram", attempted: false, deliveredIndexes: [], failures: [] };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, notificationFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    }));
    return res.ok
      ? { channel: "telegram", attempted: true, deliveredIndexes: allIndexes(eventCount), failures: [] }
      : {
          channel: "telegram",
          attempted: true,
          deliveredIndexes: [],
          failures: [`Telegram rejected the notification (HTTP ${res.status}).`],
        };
  } catch {
    return {
      channel: "telegram",
      attempted: true,
      deliveredIndexes: [],
      failures: ["Telegram notification delivery failed."],
    };
  }
}

// --- channel: generic webhook -------------------------------------------------

async function sendWebhook(userId: string, events: AccountEvent[], text: string): Promise<ChannelOutcome> {
  const url = process.env.WEBHOOK_URL;
  if (!url) return { channel: "webhook", attempted: false, deliveredIndexes: [], failures: [] };
  try {
    const res = await fetch(url, notificationFetchOptions({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Stable across retries of the same detector transition so webhook consumers can suppress
        // the unavoidable at-least-once replay if delivery succeeds but the later state write fails.
        "Idempotency-Key": notificationBatchId(userId, events),
      },
      body: JSON.stringify({
        source: "usage",
        text,
        events: events.map((e) => ({ ...e.event, account: e.accountLabel, message: eventBody(e) })),
      }),
    }));
    return res.ok
      ? { channel: "webhook", attempted: true, deliveredIndexes: allIndexes(events.length), failures: [] }
      : {
          channel: "webhook",
          attempted: true,
          deliveredIndexes: [],
          failures: [`Webhook rejected the notification (HTTP ${res.status}).`],
        };
  } catch {
    return {
      channel: "webhook",
      attempted: true,
      deliveredIndexes: [],
      failures: ["Webhook notification delivery failed."],
    };
  }
}

// --- channel: Web Push --------------------------------------------------------

export function pushConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC;
  const privateKey = process.env.VAPID_PRIVATE;
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT || "mailto:usage@localhost";
  return { publicKey, privateKey, subject };
}

interface PushOutcome extends ChannelOutcome {
  sent: number;
  removed: number;
  failed: number;
}

async function sendPush(userId: string, events: AccountEvent[]): Promise<PushOutcome> {
  const cfg = pushConfig();
  const empty: PushOutcome = {
    channel: "push",
    attempted: false,
    deliveredIndexes: [],
    failures: [],
    sent: 0,
    removed: 0,
    failed: 0,
  };
  if (!cfg) return empty;

  let sent = 0;
  let removed = 0;
  let failed = 0;
  let attempted = false;
  const deliveredIndexes = new Set<number>();
  const failures: string[] = [];
  // Whole body is guarded so a bad VAPID key, storage outage, or missing package cannot reject the
  // aggregate dispatch and take the other channels down. Unlike the old best-effort path, the
  // failure is retained so the cron can surface it and keep event-producing state retryable.
  try {
    const subs = await loadSubscriptions(userId);
    if (subs.length === 0) return empty;

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);

    for (const sub of subs) {
      // Re-check at delivery so unsafe rows saved by an older release never reach web-push.
      if (!isSafePushEndpoint(sub.endpoint)) {
        await removeSubscription(userId, sub.endpoint)
          .then(() => removed++)
          .catch(() => failures.push("An unsafe Web Push subscription could not be removed."));
        continue;
      }
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      for (const [index, e] of events.entries()) {
        attempted = true;
        const payload = JSON.stringify({
          title: eventTitle(e.event.type),
          body: eventBody(e),
          tag: `${e.accountLabel}:${e.event.limitKey}:${e.event.type}`,
          url: "/",
        });
        try {
          await webpush.sendNotification(subscription, payload, notificationWebPushOptions());
          sent++;
          deliveredIndexes.add(index);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 = the browser dropped this subscription; prune it so we stop trying.
          if (status === 404 || status === 410) {
            await removeSubscription(userId, sub.endpoint)
              .then(() => removed++)
              .catch(() => failures.push("A stale Web Push subscription could not be removed."));
            break; // this sub is dead — skip its remaining events
          }
          failed++;
        }
      }
    }
  } catch {
    attempted = true;
    failures.push("Web Push notification delivery failed before it could reach registered devices.");
  }
  if (failed > 0) failures.push(`Web Push failed for ${failed} notification delivery attempt${failed === 1 ? "" : "s"}.`);
  return { channel: "push", attempted, deliveredIndexes: [...deliveredIndexes], failures, sent, removed, failed };
}

// --- public dispatcher --------------------------------------------------------

export interface DispatchResult {
  channels: string[];
  telegram: boolean;
  webhook: boolean;
  push: { sent: number; removed: number; failed: number };
  attempted: string[];
  failures: { channel: string; error: string }[];
  // True only when every event reached at least one destination. A successful batch channel
  // (Telegram/webhook) covers all events; Web Push coverage is tracked per event across devices.
  delivered: boolean;
}

export async function dispatch(userId: string, events: AccountEvent[]): Promise<DispatchResult> {
  const result: DispatchResult = {
    channels: [],
    telegram: false,
    webhook: false,
    push: { sent: 0, removed: 0, failed: 0 },
    attempted: [],
    failures: [],
    delivered: events.length === 0,
  };
  if (events.length === 0) return result;

  const text = events.map(eventBody).join("\n");

  // TELEGRAM_* and WEBHOOK_URL are one deployment-wide destination. Never fan hosted tenants'
  // usage into that shared destination; their only configured per-user channel is Web Push.
  const globalChannelsAllowed = canUseGlobalNotificationChannels(userId);
  const skippedTelegram: ChannelOutcome = { channel: "telegram", attempted: false, deliveredIndexes: [], failures: [] };
  const skippedWebhook: ChannelOutcome = { channel: "webhook", attempted: false, deliveredIndexes: [], failures: [] };
  const [telegram, webhook, push] = await Promise.all([
    globalChannelsAllowed ? sendTelegram(text, events.length) : Promise.resolve(skippedTelegram),
    globalChannelsAllowed ? sendWebhook(userId, events, text) : Promise.resolve(skippedWebhook),
    sendPush(userId, events),
  ]);

  const outcomes: ChannelOutcome[] = [telegram, webhook, push];
  const covered = new Set(outcomes.flatMap((outcome) => outcome.deliveredIndexes));
  result.telegram = telegram.deliveredIndexes.length === events.length;
  result.webhook = webhook.deliveredIndexes.length === events.length;
  result.push = { sent: push.sent, removed: push.removed, failed: push.failed };
  result.attempted = outcomes.filter((outcome) => outcome.attempted).map((outcome) => outcome.channel);
  result.failures = outcomes.flatMap((outcome) =>
    outcome.failures.map((error) => ({ channel: outcome.channel, error })),
  );
  result.delivered = events.every((_, index) => covered.has(index));

  if (result.telegram) result.channels.push("telegram");
  if (result.webhook) result.channels.push("webhook");
  if (push.sent > 0) result.channels.push("push");
  if (!result.delivered && result.failures.length === 0) {
    result.failures.push({
      channel: "notifications",
      error:
        result.attempted.length === 0
          ? "No notification destination is configured for this tenant."
          : "No notification destination accepted every generated event.",
    });
  }
  return result;
}
