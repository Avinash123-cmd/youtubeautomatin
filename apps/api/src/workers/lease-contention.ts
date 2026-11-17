import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';

/** Lease contention is scheduling, not success or a failed processing attempt. */
export async function deferContendedJob(
  job: Pick<Job, 'moveToDelayed' | 'token'>,
  status: string | null,
  delayMs = 5000,
): Promise<void> {
  // A stale outbox delivery for a deleted/terminal job is safe to acknowledge.
  if (status === null || ['COMPLETED', 'CANCELLED', 'FAILED', 'PARTIALLY_COMPLETED'].includes(status)) return;
  await job.moveToDelayed(Date.now() + delayMs, job.token);
  // BullMQ recognizes this sentinel and does not consume attemptsMade.
  throw new DelayedError();
}

// Concurrent deliveries in one worker process must not share a lease identity.
const owners = new AsyncLocalStorage<string>();
export function currentLeaseOwner(workerId: string): string { return owners.getStore() ?? workerId; }
export function withLeaseScope<T>(workerId: string, action: () => Promise<T>): Promise<T> {
  return owners.run(`${workerId}:${randomUUID()}`, action);
}
