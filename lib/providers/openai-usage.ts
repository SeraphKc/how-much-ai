// Pure normalization: OpenAI's `GET /wham/usage` payload → the app's existing `UsageData` shape, so
// the usage bars/stats render with no provider special-casing. Each OpenAI "window" is
// `{ used_percent (0..100), limit_window_seconds, reset_after_seconds, reset_at (epoch s) }`.
// Note: the UI treats both `UsageBucket.utilization` and `LimitEntry.percent` as 0..100 percentages
// (see `lib/format.ts` extractBars), so `used_percent` maps through directly — no /100.

import type { LimitEntry, LimitScope, UsageBucket, UsageData } from "../types";

export interface OpenAIWindow {
  used_percent?: number | null;
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
}
export interface OpenAIRateLimit {
  allowed?: boolean | null;
  limit_reached?: boolean | null;
  primary_window?: OpenAIWindow | null;
  secondary_window?: OpenAIWindow | null;
}
export interface OpenAIAdditionalLimit {
  limit_name?: string | null;
  metered_feature?: string | null;
  rate_limit?: OpenAIRateLimit | null;
}
export interface WhamUsagePayload {
  plan_type?: string | null;
  email?: string | null;
  account_id?: string | null;
  user_id?: string | null;
  rate_limit?: OpenAIRateLimit | null;
  additional_rate_limits?: OpenAIAdditionalLimit[] | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  [key: string]: unknown;
}

const SESSION_MAX_S = 6 * 60 * 60; // a window ≤ 6h is a rolling "session" (Codex 5h window)
const WEEK_MIN_S = 6 * 24 * 60 * 60; // a window ≥ 6d is the weekly cap (Codex 7d window)

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function severityFor(percent: number): string {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  if (percent >= 50) return "elevated";
  return "normal";
}

function resetIso(window: OpenAIWindow): string | null {
  return typeof window.reset_at === "number" && window.reset_at > 0
    ? new Date(window.reset_at * 1000).toISOString()
    : null;
}

function windowKind(seconds: number | null): string {
  return seconds != null && seconds <= SESSION_MAX_S ? "session" : "weekly_all";
}

function assignBucket(usage: UsageData, seconds: number | null, bucket: UsageBucket): void {
  if (seconds != null && seconds <= SESSION_MAX_S) {
    if (!usage.five_hour) usage.five_hour = bucket;
  } else if (seconds == null || seconds >= WEEK_MIN_S) {
    if (!usage.seven_day) usage.seven_day = bucket;
  }
}

export function normalizeOpenAIUsage(payload: WhamUsagePayload): UsageData {
  const usage: UsageData = {};
  const limits: LimitEntry[] = [];

  const addWindow = (
    window: OpenAIWindow | null | undefined,
    opts: { kind?: string; group?: string | null; scope?: LimitScope; fillBucket: boolean },
  ) => {
    if (!window || typeof window.used_percent !== "number") return;
    const percent = clampPercent(window.used_percent);
    const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : null;
    const resets_at = resetIso(window);
    limits.push({
      kind: opts.kind ?? windowKind(seconds),
      ...(opts.group ? { group: opts.group } : {}),
      percent,
      severity: severityFor(percent),
      resets_at,
      ...(opts.scope ? { scope: opts.scope } : {}),
      is_active: true,
    });
    if (opts.fillBucket) assignBucket(usage, seconds, { utilization: percent, resets_at });
  };

  const rl = payload.rate_limit ?? null;
  addWindow(rl?.primary_window, { fillBucket: true });
  addWindow(rl?.secondary_window, { fillBucket: true });

  for (const extra of payload.additional_rate_limits ?? []) {
    const window = extra?.rate_limit?.primary_window;
    const seconds = typeof window?.limit_window_seconds === "number" ? window.limit_window_seconds : null;
    const name = typeof extra?.limit_name === "string" ? extra.limit_name : null;
    addWindow(window, {
      kind: seconds != null && seconds <= SESSION_MAX_S ? "session" : "weekly_scoped",
      group: extra?.metered_feature ?? null,
      scope: name ? { model: { id: extra?.metered_feature ?? null, display_name: name } } : undefined,
      fillBucket: false,
    });
  }

  if (limits.length > 0) usage.limits = limits;
  return usage;
}
