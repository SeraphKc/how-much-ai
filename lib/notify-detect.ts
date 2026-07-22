// Pure state→events diff for usage notifications. No I/O, no clock, no globals — every input
// is passed in — so the whole detector is deterministic and unit-testable. The cron route
// (app/api/cron/check) feeds it the previous per-limit state and the fresh reading, persists
// the returned `nextState`, and dispatches the returned `events`.

export interface LimitReading {
  key: string; // stable per-limit key (from lib/format extractBars: "session", "weekly_all", …)
  label: string; // human label ("Current session", "Weekly · Opus", …)
  percent: number; // 0–100 utilization
  resetsAt: string | null; // ISO timestamp the window rolls over, or null when inactive
}

// One row of persisted state per (account, limit).
export interface NotifyState {
  lastResetsAt: string | null; // the reset stamp we last saw — a later one means the window rolled
  peakPct: number; // highest percent observed in the current window
  warned: boolean; // whether we've already sent a WARNING for this window (once-per-window guard)
}

export interface NotifyToggles {
  recovery: boolean;
  warning: boolean;
  everyReset: boolean;
}

export interface NotifyThresholds {
  warnThreshold: number; // WARNING fires at/above this percent
  recoveryThreshold: number; // RECOVERY fires only if the window's peak reached at least this
}

export type NotifyEventType = "recovery" | "warning" | "every_reset";

export interface NotifyEvent {
  type: NotifyEventType;
  limitKey: string;
  limitLabel: string;
  percent: number; // the fresh reading's percent
  peakPct: number; // the peak that motivated the event (prior-window peak for recovery/reset)
  resetsAt: string | null;
}

export interface DiffResult {
  nextState: NotifyState;
  events: NotifyEvent[];
}

export const DEFAULT_THRESHOLDS: NotifyThresholds = { warnThreshold: 90, recoveryThreshold: 80 };
// EVERY_RESET defaults OFF — it's the chatty one. Recovery + warning are the useful signals.
export const DEFAULT_TOGGLES: NotifyToggles = { recovery: true, warning: true, everyReset: false };

function parseMs(iso: string | null): number {
  return iso ? Date.parse(iso) : NaN;
}

// Given the previous persisted state (undefined on first sighting) and a fresh reading,
// return the new state to persist plus any notifications to send.
export function diffLimit(
  prev: NotifyState | undefined,
  reading: LimitReading,
  toggles: NotifyToggles,
  thresholds: NotifyThresholds,
): DiffResult {
  // First time we've seen this limit: seed silently. We have no baseline to diff against,
  // and emitting here would fire a burst every time notifications are first enabled. Seed
  // `warned` from the current level so an already-high limit doesn't warn later in the same
  // window, but a later climb into the threshold still does.
  if (!prev) {
    return {
      nextState: {
        lastResetsAt: reading.resetsAt,
        peakPct: reading.percent,
        warned: reading.percent >= thresholds.warnThreshold,
      },
      events: [],
    };
  }

  const prevMs = parseMs(prev.lastResetsAt);
  const curMs = parseMs(reading.resetsAt);
  // A rollover is the reset stamp moving strictly LATER. A backward move is clock skew or a
  // bucket Anthropic hasn't rolled yet — not a reset. A reset into a null/inactive resets_at is
  // intentionally NOT counted (curMs is NaN): we require a concrete later stamp so a transiently
  // missing field can't fire a false recovery. Worst case we miss one recovery until the next
  // active reading, which is the safe direction to err.
  const rolledOver = !Number.isNaN(prevMs) && !Number.isNaN(curMs) && curMs > prevMs;

  const priorPeak = prev.peakPct;
  const events: NotifyEvent[] = [];
  const base = {
    limitKey: reading.key,
    limitLabel: reading.label,
    percent: reading.percent,
    resetsAt: reading.resetsAt,
  };

  if (rolledOver) {
    if (toggles.everyReset) events.push({ type: "every_reset", ...base, peakPct: priorPeak });
    // Recovery = a window you'd maxed out has rolled over AND the fresh window is actually low
    // again. If you immediately used it back up, "you're clear" would be a lie, so gate on the
    // fresh reading being below the recovery threshold.
    if (
      toggles.recovery &&
      priorPeak >= thresholds.recoveryThreshold &&
      reading.percent < thresholds.recoveryThreshold
    ) {
      events.push({ type: "recovery", ...base, peakPct: priorPeak });
    }
  }

  // A rollover clears the once-per-window warning guard.
  let warned = rolledOver ? false : prev.warned;
  if (toggles.warning && !warned && reading.percent >= thresholds.warnThreshold) {
    events.push({ type: "warning", ...base, peakPct: Math.max(priorPeak, reading.percent) });
    warned = true;
  }

  // Peak restarts at the fresh value after a rollover; otherwise it's the running max.
  const peakPct = rolledOver ? reading.percent : Math.max(prev.peakPct, reading.percent);
  // Never regress the stored stamp. A reading that's null (inactive) or earlier than what we have
  // (clock skew / a stale bucket) must not overwrite a known later stamp — otherwise the correct
  // stamp returning next tick would look like a fresh rollover and fire a false recovery.
  const lastResetsAt =
    !Number.isNaN(curMs) && (Number.isNaN(prevMs) || curMs >= prevMs) ? reading.resetsAt : prev.lastResetsAt;

  return { nextState: { lastResetsAt, peakPct, warned }, events };
}
