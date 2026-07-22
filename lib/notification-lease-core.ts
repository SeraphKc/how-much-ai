// Pure rules for the tenant-scoped notification-run lease. The Convex mutations in
// convex/notify.ts mirror these decisions transactionally; keeping the rule here gives the
// overlap/fencing behavior direct unit coverage without importing a Convex runtime.

export const NOTIFICATION_LEASE_MS = 10 * 60_000;

export interface NotificationLease {
  owner?: string;
  leaseUntil: number;
}

export function claimNotificationLease(
  current: NotificationLease | null,
  owner: string,
  now: number,
  leaseMs = NOTIFICATION_LEASE_MS,
): { acquired: boolean; owner: string | undefined; leaseUntil: number } {
  if (current && current.leaseUntil > now) {
    return { acquired: false, owner: current.owner, leaseUntil: current.leaseUntil };
  }
  return { acquired: true, owner, leaseUntil: now + leaseMs };
}

export function canMutateNotificationLease(current: NotificationLease | null, owner: string): boolean {
  return current?.owner === owner;
}
