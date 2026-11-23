import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@clipforge/database', () => ({ prisma: { processingJob: { findMany: db.findMany } } }));
import { cleanWorkDirs } from '../../apps/api/src/workers/clean-work-dirs';

let root: string;
const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);

async function directory(name: string, stale = true) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'source.mp4'), 'input');
  if (stale) await utimes(path, old, old);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clipforge-clean-work-'));
  db.findMany.mockReset();
  db.findMany.mockResolvedValue([]);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('stale work directory cleanup', () => {
  it('keeps active, paused and retryable jobs, plus recently terminal jobs', async () => {
    const [activeId, pausedId, failedId, partialId, recentId, noDateId, finishedId, orphanId] =
      Array.from({ length: 8 }, () => randomUUID());
    const protectedIds = [activeId, pausedId, failedId, partialId, recentId, noDateId];
    const [active, paused, failed, partial, recent, noDate, finished, orphan, other, fresh, uploads, imports] = await Promise.all([
      ...[activeId, pausedId, failedId, partialId, recentId, noDateId, finishedId, orphanId].map(id => directory(id)),
      directory('old-other'), directory(randomUUID(), false), directory('uploads'), directory('imports'),
    ]);
    db.findMany.mockImplementation(async ({ where }) => where.id.in
      .filter((id: string) => protectedIds.includes(id)).map((id: string) => ({ id })));
    await cleanWorkDirs(root);
    expect([active, paused, failed, partial, recent, noDate, fresh, uploads, imports].every(existsSync)).toBe(true);
    expect([finished, orphan, other].some(existsSync)).toBe(false);
    expect(db.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: expect.arrayContaining([...protectedIds, finishedId, orphanId]) },
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { completedAt: null },
          { completedAt: { gte: expect.any(Date) } },
        ],
      },
      select: { id: true },
    });
    // FAILED, PARTIALLY_COMPLETED and NEEDS_CONFIGURATION can be manually retried.
    // Completed/cancelled jobs get a grace period even if their directory is older.
  });

  it('fails closed on database errors rather than deleting an uncertain job directory', async () => {
    const jobDir = await directory(randomUUID());
    db.findMany.mockRejectedValue(new Error('database unavailable'));
    await expect(cleanWorkDirs(root)).rejects.toThrow('database unavailable');
    expect(existsSync(jobDir)).toBe(true);
  });

  it('streams and checks stale job directories in batches of at most 100', async () => {
    const ids = Array.from({ length: 205 }, () => randomUUID());
    await Promise.all(ids.map(id => directory(id)));
    await cleanWorkDirs(root);
    expect(db.findMany).toHaveBeenCalledTimes(3);
    expect(db.findMany.mock.calls.every(([args]) => args.where.id.in.length <= 100)).toBe(true);
    expect(ids.some(id => existsSync(join(root, id)))).toBe(false);
  });

  it('treats a missing work root as a no-op', async () => {
    await expect(cleanWorkDirs(join(root, 'missing'))).resolves.toBeUndefined();
    expect(db.findMany).not.toHaveBeenCalled();
  });
});
