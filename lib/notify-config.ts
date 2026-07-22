import type { NotifyConfig } from "./notify-store";

function clampInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export type NotifyConfigParseResult =
  | { ok: true; config: NotifyConfig }
  | { ok: false; error: string };

// Normalize the numeric inputs as before, then validate the detector's hysteresis: recovery must
// be the lower boundary and warning the upper boundary. Equal/reversed values make resets noisy or
// semantically contradictory, so the API asks the caller to correct them instead of silently save.
export function parseNotifyConfig(body: unknown): NotifyConfigParseResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const config: NotifyConfig = {
    recovery: bool(b.recovery, true),
    warning: bool(b.warning, true),
    everyReset: bool(b.everyReset, false),
    warnThreshold: clampInt(b.warnThreshold, 90),
    recoveryThreshold: clampInt(b.recoveryThreshold, 80),
  };

  if (config.recoveryThreshold >= config.warnThreshold) {
    return { ok: false, error: "Recovery threshold must be lower than warning threshold." };
  }
  return { ok: true, config };
}
