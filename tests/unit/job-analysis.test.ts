import 'reflect-metadata';
import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ processingJob: { findFirst: vi.fn() }, transcript: { findFirst: vi.fn() }, transcriptSegment: { findMany: vi.fn(), count: vi.fn() }, highlightCandidate: { findMany: vi.fn(), count: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
import { JobsService } from '../../apps/api/src/jobs/jobs.service';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
const service = new JobsService({} as never, {} as never);
const ctx = { workspaceId: 'workspace-a' } as RequestContext;
beforeEach(() => {
  vi.clearAllMocks();
  db.processingJob.findFirst.mockResolvedValue({ id: 'owned' });
  db.transcript.findFirst.mockResolvedValue({ id: 'transcript', provider: 'faster-whisper', language: 'en' });
  db.transcriptSegment.findMany.mockResolvedValue([{ id: 'segment', startSeconds: .125, endSeconds: .875, text: 'Actual' }]);
  db.transcriptSegment.count.mockResolvedValue(51);
  db.highlightCandidate.findMany.mockResolvedValue([]); db.highlightCandidate.count.mockResolvedValue(0);
});
it('does not read transcript or candidate data for another workspace', async () => {
  db.processingJob.findFirst.mockResolvedValue(null);
  await expect(service.analysis('not-owned', ctx, { page: 1, pageSize: 50 })).rejects.toMatchObject({ status: 404 });
  expect(db.processingJob.findFirst).toHaveBeenCalledWith({ where: { id: 'not-owned', workspaceId: 'workspace-a' }, select: { id: true } });
  expect(db.transcript.findFirst).not.toHaveBeenCalled(); expect(db.highlightCandidate.findMany).not.toHaveBeenCalled();
});
it('preserves source timing, scopes candidate reads and bounds paginated segments', async () => {
  const result = await service.analysis('owned', ctx, { page: 2, pageSize: 50 });
  expect(result.segments[0].startSeconds).toBe(.125);
  expect(db.transcriptSegment.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50, where: { transcriptId: 'transcript' } }));
  expect(db.highlightCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50, where: { jobId: 'owned', workspaceId: 'workspace-a' } }));
});
it('returns an honest empty transcript while the worker has not produced one', async () => {
  db.transcript.findFirst.mockResolvedValue(null);
  const result = await service.analysis('owned', ctx, { page: 1, pageSize: 50 });
  expect(result.transcript).toBeNull(); expect(result.segments).toEqual([]); expect(result.segmentCount).toBe(0);
  expect(db.transcriptSegment.findMany).not.toHaveBeenCalled();
});
