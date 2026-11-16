import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ processingJob: { findMany: vi.fn() }, publishingJob: { findMany: vi.fn() }, clipVariant: { findMany: vi.fn() }, sourceVideo: { findMany: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { JOB_LEASE_SECONDS: 300 } }));
import { DiagnosticsService } from '../../apps/api/src/system/diagnostics.service';
const service = new DiagnosticsService({} as never, {} as never, {} as never) as unknown as { stuckJobs(workspaceId: string): Promise<unknown>; stuckPublishingJobs(workspaceId: string): Promise<unknown>; mediaIntegrity(workspaceId: string): Promise<unknown> };
beforeEach(() => { vi.clearAllMocks(); for (const model of Object.values(db)) model.findMany.mockResolvedValue([]); });
describe('workspace diagnostic record isolation', () => {
  it('scopes stuck processing samples and uses lease seconds as seconds', async () => {
    const before = Date.now();
    await service.stuckJobs('workspace-a');
    const query = db.processingJob.findMany.mock.calls[0][0];
    expect(query.where.workspaceId).toBe('workspace-a');
    expect(before - query.where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(599000);
  });
  it('scopes stalled publishing samples', async () => {
    await service.stuckPublishingJobs('workspace-a');
    expect(db.publishingJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'workspace-a' }) }));
  });
  it('never samples another workspace media or deleted sources', async () => {
    await service.mediaIntegrity('workspace-a');
    expect(db.clipVariant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clip: { workspaceId: 'workspace-a' } } }));
    expect(db.sourceVideo.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'workspace-a', deletedAt: null } }));
  });
});
