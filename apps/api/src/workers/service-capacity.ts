import { JobLeaseLostError, prisma } from '@clipforge/database';
import { ServiceCapacityError } from './services-client';

/** The job was cancelled, finished, or deleted while a service was at capacity. */
export class JobNoLongerActiveError extends Error {
  constructor() { super('Processing job is no longer active'); }
}

interface RetryOptions {
  beforeRetry: () => Promise<void>;
  onCapacity?: (error: ServiceCapacityError, delayMs: number, count: number) => void;
  // Injectable for deterministic tests; production uses a real, jittered timer.
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

/**
 * Retry only an explicit refusal made before the Python service starts work. Keep the
 * same BullMQ delivery and database lease alive so that analysis already in memory is
 * not paid for again, the recovery sweep does not create duplicates, and neither retry
 * budget is consumed by ordinary capacity pressure. Other failures remain ambiguous.
 */
export async function retryServiceCapacity<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let count = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ServiceCapacityError)) throw error;
      const backoff = Math.min(30_000, 5_000 * 2 ** Math.min(count, 3));
      const delayMs = Math.ceil(Math.max(error.retryAfterMs, backoff) * (1 + (options.random ?? Math.random)() * 0.25));
      count += 1;
      options.onCapacity?.(error, delayMs, count);
      await (options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(delayMs);
      // A cancellation, lost lease, or failed DB read must prevent the next submission.
      await options.beforeRetry();
    }
  }
}

/** Check after each backoff, before sending another potentially expensive request. */
export async function assertActiveJobLease(jobId: string, owner: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    select: { status: true, workerId: true, leaseExpiresAt: true },
  });
  if (!job || ['CANCELLED', 'FAILED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION'].includes(job.status)) {
    throw new JobNoLongerActiveError();
  }
  if (job.workerId !== owner || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= Date.now()) {
    throw new JobLeaseLostError();
  }
}

export type CapacityAwareCall = <T>(operation: () => Promise<T>) => Promise<T>;

export function capacityAwareCalls(
  jobId: string,
  owner: string,
  logger: { warn: (message: string) => unknown },
): CapacityAwareCall {
  return operation => retryServiceCapacity(operation, {
    beforeRetry: () => assertActiveJobLease(jobId, owner),
    onCapacity: (error, delayMs, count) => {
      if (count === 1 || count % 10 === 0) {
        logger.warn(`job ${jobId}: ${error.service} is at capacity; retrying the same request in ${Math.ceil(delayMs / 1000)}s`);
      }
    },
  });
}
