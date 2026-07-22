// Delivery/state orchestration for one notification detector pass. Keeping this dependency-injected
// makes the failure semantics directly testable without importing Next, Convex, or web-push.

import type { AccountEvent, DispatchResult } from "./notify";

export interface NotificationCycleError {
  stage: "delivery" | "state";
  error: string;
}

export interface NotificationCycleResult {
  dispatch: DispatchResult;
  persisted: number;
  errors: NotificationCycleError[];
}

export type AccountStateObservation<State> =
  | { accountId: string; available: true; states: State[] }
  | { accountId: string; available: false };

// Build the complete detector-state snapshot for replacement in Convex. Removed accounts disappear;
// successfully-read accounts replace their rows (which prunes vanished limit keys); temporarily
// unavailable accounts retain their last-known rows so an upstream outage cannot erase history.
export function reconcileNotificationStates<State extends { accountId: string; key: string }>(
  previousStates: State[],
  activeAccountIds: ReadonlySet<string>,
  observations: AccountStateObservation<State>[],
): State[] {
  const previousByAccount = new Map<string, State[]>();
  for (const state of previousStates) {
    const rows = previousByAccount.get(state.accountId) ?? [];
    rows.push(state);
    previousByAccount.set(state.accountId, rows);
  }
  const observationByAccount = new Map(observations.map((observation) => [observation.accountId, observation]));
  const snapshot: State[] = [];
  for (const accountId of activeAccountIds) {
    const observation = observationByAccount.get(accountId);
    if (observation?.available) snapshot.push(...observation.states);
    else snapshot.push(...(previousByAccount.get(accountId) ?? []));
  }
  return snapshot;
}

const emptyDispatch = (eventCount: number): DispatchResult => ({
  channels: [],
  telegram: false,
  webhook: false,
  push: { sent: 0, removed: 0, failed: 0 },
  attempted: [],
  failures: [],
  delivered: eventCount === 0,
});

// At-least-once policy:
//   * Seed/no-event state can be persisted immediately.
//   * State that generated an event is persisted only after every event reached at least one target.
//   * Delivery always runs before that state write. If the later write fails, a future cron can send
//     a duplicate, but the original alert is never silently lost. This is the safe side of the tradeoff.
export async function completeNotificationCycle<State extends { key: string }>({
  userId,
  events,
  states,
  previousStates,
  eventfulStateKeys,
  dispatchEvents,
  persistStates,
}: {
  userId: string;
  events: AccountEvent[];
  states: State[];
  previousStates: State[];
  eventfulStateKeys: ReadonlySet<string>;
  dispatchEvents: (userId: string, events: AccountEvent[]) => Promise<DispatchResult>;
  persistStates: (userId: string, states: State[]) => Promise<void>;
}): Promise<NotificationCycleResult> {
  const errors: NotificationCycleError[] = [];
  let dispatch = emptyDispatch(events.length);

  if (events.length > 0) {
    try {
      dispatch = await dispatchEvents(userId, events);
      for (const failure of dispatch.failures) {
        errors.push({ stage: "delivery", error: `${failure.channel}: ${failure.error}` });
      }
    } catch {
      errors.push({ stage: "delivery", error: "Notification dispatch failed unexpectedly." });
    }
  }

  // When delivery is incomplete, persist only limits that produced no events. Their ordinary peak
  // tracking should continue, while event-producing limits retain their prior state and retry.
  const previousByKey = new Map(previousStates.map((state) => [state.key, state]));
  const eligibleStates = dispatch.delivered
    ? states
    : states.flatMap((state) => {
        if (!eventfulStateKeys.has(state.key)) return [state];
        const previous = previousByKey.get(state.key);
        return previous ? [previous] : [];
      });

  if (!dispatch.delivered && !errors.some((error) => error.stage === "delivery")) {
    errors.push({ stage: "delivery", error: "Generated notifications did not reach a destination." });
  }

  try {
    // Persistence replaces the tenant snapshot, so an empty list intentionally prunes all stale rows.
    await persistStates(userId, eligibleStates);
  } catch {
    errors.push({ stage: "state", error: "Couldn't persist notification detector state." });
    return { dispatch, persisted: 0, errors };
  }

  return { dispatch, persisted: eligibleStates.length, errors };
}
