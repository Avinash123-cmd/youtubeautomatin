import { expect, it, vi } from 'vitest';
const updateMany = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }));
vi.mock('../../packages/database/src/client', () => ({ prisma: { processingJob: { updateMany } } }));
import { acquireJobLease, releaseJobLease } from '../../packages/database/src/repositories';
it('does not permit a concurrent same-process handler to reacquire an unexpired parent lease', async () => {
  expect(await acquireJobLease('job-a', 'worker-a:delivery-a', 60)).toBe(true);
  const args = updateMany.mock.calls.at(-1)![0];
  expect(args.where.OR).toEqual([{ workerId: null }, { leaseExpiresAt: { lt: expect.any(Date) } }]);
  expect(args.where.status.notIn).toContain('FAILED');
  expect(args.data).not.toHaveProperty('attempt');
});
it('only releases the callers lease when an owner is supplied', async () => {
  await releaseJobLease('job-a', 'worker-a:delivery-a');
  expect(updateMany).toHaveBeenLastCalledWith({ where: { id: 'job-a', workerId: 'worker-a:delivery-a' }, data: { workerId: null, leaseExpiresAt: null } });
});
