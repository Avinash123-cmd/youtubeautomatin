import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ tx: { $queryRaw: vi.fn(), $executeRaw: vi.fn(), processingJob: { findUnique: vi.fn(), update: vi.fn() }, jobStage: { updateMany: vi.fn(), upsert: vi.fn() }, outboxEvent: { create: vi.fn() } }, transaction: vi.fn() }));
vi.mock('../../packages/database/src/client', () => ({ prisma: { $transaction: mocks.transaction } }));
import { transitionJobInTransaction, JobLeaseLostError, IllegalTransitionError } from '../../packages/database/src/repositories';
import { recoverProcessingJob } from '../../packages/database/src/recovery';
let job: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks();
  job = { id: 'job-a', status: 'RENDERING', stage: 'RENDERING', workerId: 'old-owner', leaseExpiresAt: new Date(Date.now() - 10000), heartbeatAt: new Date(0), attempt: 0, maxAttempts: 3, startedAt: new Date(0), stages: [], clips: [{ id: 'clip-a', status: 'PLANNED' }] };
  mocks.transaction.mockImplementation(action => action(mocks.tx));
  mocks.tx.processingJob.findUnique.mockImplementation(async () => ({ ...job }));
  mocks.tx.processingJob.update.mockImplementation(async ({ data }) => { job = { ...job, ...data, ...(data.attempt ? { attempt: job.attempt + data.attempt.increment } : {}) }; return { ...job }; });
  mocks.tx.outboxEvent.create.mockResolvedValue({ id: 'outbox-a' });
});
it('locks the current row before any state read and refuses stale worker transitions', async () => {
  job.workerId = 'new-owner'; job.leaseExpiresAt = new Date(Date.now() + 60000);
  await expect(transitionJobInTransaction(mocks.tx as never, 'job-a', 'VALIDATION', { expectedLeaseOwner: 'old-owner' })).rejects.toBeInstanceOf(JobLeaseLostError);
  expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.processingJob.findUnique.mock.invocationCallOrder[0]);
  expect(mocks.tx.processingJob.update).not.toHaveBeenCalled();
});
it('does not recover a renewed live lease, even if the sweep selected a stale snapshot', async () => {
  job.leaseExpiresAt = new Date(Date.now() + 60000);
  expect(await recoverProcessingJob('job-a', 120)).toBe('skipped');
  expect(mocks.tx.processingJob.update).not.toHaveBeenCalled(); expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
});
it.each(['CANCELLED', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'QUEUED', 'NEEDS_CONFIGURATION'])('ignores terminal/ineligible %s state after locking', async status => {
  job.status = status; expect(await recoverProcessingJob('job-a', 120)).toBe('skipped');
  expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
});
it('recovers zero-ready renders directly and atomically consumes the retry budget', async () => {
  expect(await recoverProcessingJob('job-a', 120)).toBe('render');
  expect(job.attempt).toBe(1); expect(job.workerId).toBeNull(); expect(job.leaseExpiresAt).toBeNull();
  expect(mocks.tx.outboxEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ queue: 'clipforge.render', payload: { clipId: 'clip-a', jobId: 'job-a' } }) });
  expect(await recoverProcessingJob('job-a', 120)).toBe('skipped'); // fresh heartbeat prevents duplicate sweep
});
it('requeues one ready output to finalize a parent abandoned after all clip writes', async () => {
  job.clips = [{ id: 'ready-a', status: 'READY' }, { id: 'ready-b', status: 'READY' }];
  expect(await recoverProcessingJob('job-a', 120)).toBe('render');
  expect(mocks.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
});
it('enforces retry exhaustion before partial render recovery', async () => {
  job.attempt = 3;
  expect(await recoverProcessingJob('job-a', 120)).toBe('failed');
  expect(job.status).toBe('FAILED'); expect(job.workerId).toBeNull();
  expect(mocks.tx.jobStage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: 'FAILED' }) }));
  expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
});
it('atomically records resumed pipeline state and outbox intent', async () => {
  job.status = job.stage = 'TRANSCRIBING'; job.clips = [];
  job.stages = [{ stage: 'PROBING' }];
  expect(await recoverProcessingJob('job-a', 120)).toBe('pipeline');
  expect(mocks.tx.outboxEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ queue: 'clipforge.pipeline', payload: { jobId: 'job-a', resumeFrom: 'PROBING' } }) });
});
it('does not resurrect cancellation and records cancelled stages accurately', async () => {
  await transitionJobInTransaction(mocks.tx as never, 'job-a', 'CANCELLED');
  expect(mocks.tx.jobStage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
  await expect(transitionJobInTransaction(mocks.tx as never, 'job-a', 'VALIDATION')).rejects.toBeInstanceOf(IllegalTransitionError);
});
it('propagates outbox errors so Prisma can roll back the entire recovery transaction', async () => {
  mocks.tx.outboxEvent.create.mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(recoverProcessingJob('job-a', 120)).rejects.toThrow('outbox unavailable');
  // The mock does not implement SQL rollback; this checks propagation, not database isolation.
});
it('preserves delayed enqueue metadata in the state-change transaction', async () => {
  const availableAt = new Date(Date.now() + 15000);
  await transitionJobInTransaction(mocks.tx as never, 'job-a', 'RETRYING', { enqueue: { queue: 'clipforge.pipeline', eventType: 'job.retry', payload: { jobId: 'job-a' }, availableAt } });
  expect(mocks.tx.outboxEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ availableAt }) });
});
