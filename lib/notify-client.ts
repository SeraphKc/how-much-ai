// Browser-side helpers for the Notifications panel: read/write config and manage this device's
// Web Push subscription. All functions here assume they run in the browser.

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  const forwardAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) forwardAbort();
  else upstream?.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error("The request timed out after 20 seconds. Try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", forwardAbort);
  }
}

async function promiseWithTimeout<T>(promise: Promise<T>, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${action} timed out after 20 seconds. Try again.`)), 20_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface NotifyConfig {
  recovery: boolean;
  warning: boolean;
  everyReset: boolean;
  warnThreshold: number;
  recoveryThreshold: number;
}

export interface NotifySettings {
  ready: boolean; // Convex backend configured
  pushConfigured: boolean; // VAPID keys present on the server
  vapidPublicKey: string | null;
  config: NotifyConfig | null;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  recovery: true,
  warning: true,
  everyReset: false,
  warnThreshold: 90,
  recoveryThreshold: 80,
};

export async function fetchNotifySettings(signal?: AbortSignal): Promise<NotifySettings> {
  const res = await fetchWithTimeout("/api/notify", { cache: "no-store", signal });
  if (!res.ok) throw new Error("Couldn't load notification settings");
  return (await res.json()) as NotifySettings;
}

export async function saveNotifyConfig(config: NotifyConfig): Promise<NotifyConfig> {
  const res = await fetchWithTimeout("/api/notify", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Couldn't save notification settings");
  return data.config as NotifyConfig;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

// VAPID public keys are URL-safe base64; the browser's subscribe() wants a BufferSource. Back the
// view with an explicit ArrayBuffer so the type is ArrayBuffer (not ArrayBufferLike) — the DOM
// lib types reject a possibly-SharedArrayBuffer-backed view for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function applicationServerKeyMatches(
  current: BufferSource | null | undefined,
  vapidPublicKey: string,
): boolean {
  if (!current) return false;
  const expected = urlBase64ToUint8Array(vapidPublicKey);
  const actual = ArrayBuffer.isView(current)
    ? new Uint8Array(current.buffer, current.byteOffset, current.byteLength)
    : new Uint8Array(current);
  if (actual.byteLength !== expected.byteLength) return false;
  for (let index = 0; index < actual.byteLength; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await promiseWithTimeout(navigator.serviceWorker.getRegistration(), "Checking push support");
  return reg ? promiseWithTimeout(reg.pushManager.getSubscription(), "Checking the push subscription") : null;
}

export interface EnablePushResult {
  ok: boolean;
  reason?: "unsupported" | "denied" | "error";
  message?: string;
}

async function rollbackBrowserSubscription(
  subscription: PushSubscription,
  message: string,
): Promise<EnablePushResult> {
  try {
    const removed = await promiseWithTimeout(subscription.unsubscribe(), "Rolling back the push subscription");
    return removed
      ? { ok: false, reason: "error", message }
      : {
          ok: false,
          reason: "error",
          message: `${message} The browser subscription could not be rolled back; try disabling notifications again.`,
        };
  } catch {
    return {
      ok: false,
      reason: "error",
      message: `${message} The browser subscription could not be rolled back; try disabling notifications again.`,
    };
  }
}

async function unregisterServerSubscription(endpoint: string): Promise<void> {
  const res = await fetchWithTimeout("/api/notify/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Couldn't unregister this device.");
}

export async function enablePush(vapidPublicKey: string): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported", message: "This browser can't do web push." };

  const permission = await promiseWithTimeout(Notification.requestPermission(), "Notification permission");
  if (permission !== "granted") {
    return { ok: false, reason: "denied", message: "Notifications are blocked for this site." };
  }

  let createdSubscription: PushSubscription | null = null;
  try {
    const reg = await promiseWithTimeout(navigator.serviceWorker.register("/sw.js"), "Registering notification support");
    await promiseWithTimeout(navigator.serviceWorker.ready, "Starting notification support");
    let existing = await promiseWithTimeout(reg.pushManager.getSubscription(), "Checking the push subscription");
    if (existing && !applicationServerKeyMatches(existing.options.applicationServerKey, vapidPublicKey)) {
      await unregisterServerSubscription(existing.endpoint);
      const removed = await promiseWithTimeout(existing.unsubscribe(), "Replacing the push subscription");
      if (!removed) throw new Error("Couldn't replace the browser's outdated push subscription.");
      existing = null;
    }
    const subscription =
      existing ??
      (await promiseWithTimeout(
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }),
        "Creating the push subscription",
      ));
    if (!existing) createdSubscription = subscription;

    const res = await fetchWithTimeout("/api/notify/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const message = data?.error || "Couldn't register this device.";
      return createdSubscription
        ? rollbackBrowserSubscription(createdSubscription, message)
        : { ok: false, reason: "error", message };
    }
    createdSubscription = null;
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't enable push.";
    return createdSubscription
      ? rollbackBrowserSubscription(createdSubscription, message)
      : { ok: false, reason: "error", message };
  }
}

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await unregisterServerSubscription(sub.endpoint);
  const removed = await promiseWithTimeout(sub.unsubscribe(), "Disabling the push subscription");
  if (!removed) throw new Error("The browser couldn't disable this push subscription. Please try again.");
}
