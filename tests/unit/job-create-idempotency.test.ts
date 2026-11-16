import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), sourceVideo: { findFirst: vi.fn() }, subtitlePreset: { findFirst: vi.fn() }, processingJob: { findFirst: vi.fn(), create: vi.fn() }, jobStage: { create: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }, writeOutbox: vi.fn(), appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
import { JobsService } from '../../apps/api/src/jobs/jobs.service';
import { processingRequest } from '../../apps/web/lib/processing-request';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
const sourceId = '1b726681-2718-4545-8874-0758f0303f12';
const service = new JobsService({ resolveForProcessing: vi.fn().mockResolvedValue({ maxOutputClips: 6 }) } as never, { notify: vi.fn().mockResolvedValue(undefined) } as never);
const ctx = { workspaceId: 'workspace-a', userId: 'user', email: 'owner@example.test' } as RequestContext;
const input = processingRequest(sourceId, { 'render.framing_mode': 'center_crop', 'subtitles.preset_id': sourceId, 'subtitles.language': 'en', 'ai.max_output_clips': 6, 'ai.min_quality_score': 70 }, [15, 30]);
beforeEach(() => {
  vi.clearAllMocks();
  db.sourceVideo.findFirst.mockResolvedValue({ id: sourceId, status: 'VALIDATED', rightsDeclaration: {}, jobs: [] });
  db.subtitlePreset.findFirst.mockResolvedValue({ style: {} });
  db.processingJob.findFirst.mockResolvedValue(null);
});
describe('job creation transaction guards (repository stub)', () => {
  it('rechecks active jobs after locking the source and refuses the losing creator', async () => {
    db.processingJob.findFirst.mockResolvedValue({ id: 'winner-job' });
    await expect(service.create(input, ctx)).rejects.toMatchObject({ status: 409 });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.processingJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sourceVideoId: sourceId, workspaceId: 'workspace-a' }) }));
    expect(db.processingJob.create).not.toHaveBeenCalled();
  });
  it('refuses a source archived or removed after preflight', async () => {
    db.sourceVideo.findFirst.mockResolvedValueOnce({ id: sourceId, status: 'VALIDATED', rightsDeclaration: {}, jobs: [] }).mockResolvedValueOnce(null);
    await expect(service.create(input, ctx)).rejects.toMatchObject({ status: 409 });
    expect(db.processingJob.create).not.toHaveBeenCalled();
  });
});
