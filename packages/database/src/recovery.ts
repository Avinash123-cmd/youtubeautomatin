import { type JobState, isTerminal } from '@clipforge/shared-types';
import { prisma } from './client';
import { transitionJobInTransaction } from './repositories';
import { writeOutbox } from './outbox';

/** Recheck under the same row lock as transitions and lease claims; never trust sweep snapshots. */
export async function recoverProcessingJob(jobId: string, staleAfterSeconds: number): Promise<'skipped' | 'failed' | 'render' | 'pipeline'> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ProcessingJob" WHERE "id" = ${jobId}::uuid FOR UPDATE`;
    const job = await tx.processingJob.findUnique({
      where: { id: jobId },
      include: { stages: { where: { status: 'SUCCEEDED' }, orderBy: { finishedAt: 'asc' } }, clips: { orderBy: { createdAt: 'asc' } } },
    });
    const now = new Date();
    if (!job || isTerminal(job.status as JobState) || ['QUEUED', 'NEEDS_CONFIGURATION'].includes(job.status)) return 'skipped';
    if (job.leaseExpiresAt && job.leaseExpiresAt > now) return 'skipped';
    if (!job.leaseExpiresAt && job.heartbeatAt && job.heartbeatAt.getTime() > now.getTime() - staleAfterSeconds * 1000) return 'skipped';
    // Publishing has its own durable operation reconciliation; never rerun analysis for it.
    if (['PUBLISHING', 'PUBLISHING_QUEUED'].includes(job.stage)) return 'skipped';
    if (job.attempt >= job.maxAttempts) {
      await transitionJobInTransaction(tx, jobId, 'FAILED', { errorCode: 'RETRY_BUDGET_EXHAUSTED', errorMessage: 'Worker loss recovery exhausted the retry budget', progressDetail: `Recovery exhausted at ${job.stage}` });
      return 'failed';
    }
    const rendering = ['RENDERING', 'VALIDATION', 'ASSET_STORAGE'].includes(job.stage) && job.clips.length > 0;
    const recoverable: JobState[] = ['PROBING', 'TRANSCRIBING', 'AI_ANALYSIS', 'CLIP_SELECTION'];
    const last = job.stages.filter(stage => recoverable.includes(stage.stage as JobState)).at(-1)?.stage;
    const resumeFrom: JobState = rendering ? 'RENDERING' : (last as JobState | undefined) ?? 'PROBING';
    await transitionJobInTransaction(tx, jobId, 'RETRYING', { workerId: null, progressDetail: `Worker lost at ${job.stage}; recovering`, errorCode: 'WORKER_LOST', errorMessage: 'Processing worker lease expired' });
    // An existing RETRYING row still consumes recovery budget; idempotent transitions do not.
    if (job.status === 'RETRYING') await tx.processingJob.update({ where: { id: jobId }, data: { attempt: { increment: 1 } } });
    await transitionJobInTransaction(tx, jobId, resumeFrom, {
      workerId: null, progressDetail: `Recovering ${resumeFrom} after worker loss`,
      ...(!rendering ? { enqueue: { queue: 'clipforge.pipeline', eventType: 'job.recover', payload: { jobId, resumeFrom } } } : {}),
    });
    // Refresh the stale marker and clear only this transaction's old lease, before commit.
    await tx.processingJob.update({ where: { id: jobId }, data: { workerId: null, leaseExpiresAt: null, heartbeatAt: now } });
    if (rendering) {
      const pending = job.clips.filter(clip => clip.status !== 'READY');
      // All outputs may have committed just before the crash: a READY clip delivery finalizes
      // the parent via maybeAdvanceJob without rerendering or redoing expensive analysis.
      const targets = pending.length ? pending : job.clips.slice(0, 1);
      for (const clip of targets) await writeOutbox(tx, { aggregateType: 'GeneratedClip', aggregateId: clip.id, eventType: 'clip.render', queue: 'clipforge.render', payload: { clipId: clip.id, jobId } });
    }
    return rendering ? 'render' : 'pipeline';
  });
}
