import { opendir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '@clipforge/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_SIZE = 100;
// Unlike failed or partially completed jobs, these cannot be manually retried.
const NON_RETRYABLE = ['COMPLETED', 'CANCELLED'] as const;

/**
 * Protect processing inputs throughout a capacity wait and any later manual retry.
 * A completed/cancelled job is eligible only after both its directory and its
 * terminal state are 48 hours old. Enumeration and DB lookups are batched; if
 * the DB is unavailable, fail closed for any batch containing UUID directories.
 * Publishing scratch directories are clip IDs, not processing-job IDs.
 */
export async function cleanWorkDirs(root: string, now = Date.now()): Promise<void> {
  const dir = await opendir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!dir) return;
  const cutoff = now - 48 * 3600 * 1000;
  const pending: Array<{ path: string; jobId: string | null }> = [];
  const flush = async () => {
    if (!pending.length) return;
    const ids = pending.flatMap(item => item.jobId ? [item.jobId] : []);
    const protectedJobs = ids.length ? await prisma.processingJob.findMany({
      where: {
        id: { in: ids },
        OR: [
          { status: { notIn: [...NON_RETRYABLE] } },
          { completedAt: null },
          { completedAt: { gte: new Date(cutoff) } },
        ],
      },
      select: { id: true },
    }) : [];
    const protectedIds = new Set(protectedJobs.map(job => job.id.toLowerCase()));
    for (const item of pending) {
      if (item.jobId && protectedIds.has(item.jobId)) continue;
      await rm(item.path, { recursive: true, force: true }).catch(() => undefined);
    }
    pending.length = 0;
  };

  // opendir streams entries instead of loading every directory into memory.
  for await (const entry of dir) {
    if (entry.name === 'uploads' || entry.name === 'imports') continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < cutoff) {
      pending.push({ path, jobId: UUID.test(entry.name) ? entry.name.toLowerCase() : null });
      if (pending.length >= BATCH_SIZE) await flush();
    }
  }
  await flush();
}
