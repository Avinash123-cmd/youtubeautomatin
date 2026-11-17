/**
 * Recovery worker — makes the platform survive crashes.
 *
 * Every 30 seconds it looks for jobs whose worker lease expired while unfinished,
 * checks whether the previous stage actually completed (by inspecting its durable
 * artefacts, not assumptions), then resumes from the last successful stage.
 */
import { prisma, writeOutbox, recoverProcessingJob } from '@clipforge/database';
import { findAbandonedJobs } from '@clipforge/database';
import { env } from '../common/env';
import { createRuntime, wireShutdown } from './base';

const runtime = createRuntime('recovery', 1);

async function sweep(): Promise<void> {
  const staleAfter = Math.max(60, env.JOB_LEASE_SECONDS);
  const abandoned = await findAbandonedJobs(staleAfter);
  for (const entry of abandoned) {
    try {
      const outcome = await recoverProcessingJob(entry.jobId, staleAfter);
      if (outcome !== 'skipped') runtime.logger.info(`recovery ${entry.jobId}: ${outcome}`);
    } catch {
      runtime.logger.error(`processing recovery failed for ${entry.jobId}; transaction rolled back`);
    }
  }

  // Publishing jobs whose worker died mid-flight.
  const stuckPublishing = await prisma.publishingJob.findMany({
    where: {
      status: { in: ['UPLOADING', 'AWAITING_PLATFORM'] },
      updatedAt: { lt: new Date(Date.now() - 10 * 60_000) },
    },
    take: 20,
  });
  for (const candidate of stuckPublishing) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PublishingJob" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
      const publishingJob = await tx.publishingJob.findUnique({ where: { id: candidate.id } });
      const now = new Date();
      if (!publishingJob || !['UPLOADING', 'AWAITING_PLATFORM'].includes(publishingJob.status) ||
          publishingJob.updatedAt.getTime() >= now.getTime() - 10 * 60_000 ||
          (publishingJob.leaseExpiresAt && publishingJob.leaseExpiresAt > now)) return;
      if (publishingJob.attempt >= publishingJob.maxAttempts) {
        await tx.publishingJob.update({ where: { id: publishingJob.id }, data: {
          status: 'FAILED', retryable: false, errorCode: 'RETRY_BUDGET_EXHAUSTED',
          errorMessage: 'Publishing worker loss exhausted the retry budget', completedAt: now,
          workerId: null, leaseExpiresAt: null,
        } });
        return;
      }
      await tx.publishingJob.update({ where: { id: publishingJob.id }, data: { status: 'QUEUED', workerId: null, leaseExpiresAt: null } });
      await writeOutbox(tx, { aggregateType: 'PublishingJob', aggregateId: publishingJob.id,
        eventType: 'publish.requested', queue: 'clipforge.publish',
        payload: { publishingJobId: publishingJob.id, recovered: true },
      });
    });
  }
}

async function main() {
  runtime.logger.info('recovery worker started (30s sweep)');
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep().catch(() => runtime.logger.error('recovery sweep failed'))
      .finally(() => { sweeping = false; });
  }, 30_000);
  wireShutdown(runtime, []);
}

void main();
