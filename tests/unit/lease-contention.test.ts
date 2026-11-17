import { expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import { deferContendedJob } from '../../apps/api/src/workers/lease-contention';
it('delays contended work without acknowledging it or consuming a processing retry', async () => {
  const job = { token: 'isolated-lock', moveToDelayed: vi.fn().mockResolvedValue(undefined) };
  const before = Date.now();
  await expect(deferContendedJob(job, 'RENDERING')).rejects.toBeInstanceOf(DelayedError);
  expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'isolated-lock');
  expect(job.moveToDelayed.mock.calls[0][0]).toBeGreaterThanOrEqual(before + 5000);
});
it.each([null, 'FAILED', 'COMPLETED', 'CANCELLED', 'PARTIALLY_COMPLETED'])('acknowledges stale terminal/missing deliveries (%s)', async status => {
  const job = { token: 'lock', moveToDelayed: vi.fn() };
  await deferContendedJob(job, status); expect(job.moveToDelayed).not.toHaveBeenCalled();
});
it('propagates Redis delay failure instead of losing the delivery', async () => {
  const error = new Error('redis unavailable');
  await expect(deferContendedJob({ token: 'lock', moveToDelayed: vi.fn().mockRejectedValue(error) }, 'RENDERING')).rejects.toBe(error);
});

import { currentLeaseOwner, withLeaseScope } from '../../apps/api/src/workers/lease-contention';
it('isolates lease ownership for concurrent deliveries on the same worker', async () => {
  const owners = await Promise.all([1, 2].map(() => withLeaseScope('worker-a', async () => {
    const before = currentLeaseOwner('worker-a');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(currentLeaseOwner('worker-a')).toBe(before);
    return before;
  })));
  expect(owners[0]).not.toBe(owners[1]);
  expect(currentLeaseOwner('worker-a')).toBe('worker-a');
});
