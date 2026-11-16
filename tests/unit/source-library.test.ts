import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ sourceVideo: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db, appendAuditLog: vi.fn() }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { UPLOAD_PART_SIZE_MIB: 16 } }));
import { SourcesService } from '../../apps/api/src/sources/sources.service';
import { sourceListQuerySchema } from '@clipforge/validation';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
const service = new SourcesService({} as never, {} as never, {} as never);
const ctx = { workspaceId: 'workspace-a' } as RequestContext;
beforeEach(() => { vi.clearAllMocks(); db.sourceVideo.findMany.mockResolvedValue([]); db.sourceVideo.count.mockResolvedValue(0); });
describe('paginated source library', () => {
  it('scopes search and count to the current workspace and excludes deleted sources', async () => {
    await service.list(ctx, sourceListQuerySchema.parse({ search: 'Episode', status: 'VALIDATED', page: '2', pageSize: '20' }));
    const query = db.sourceVideo.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: 'workspace-a', deletedAt: null, status: 'VALIDATED', originalFileName: { contains: 'Episode', mode: 'insensitive' } });
    expect(query.skip).toBe(20); expect(query.take).toBe(20);
    expect(db.sourceVideo.count).toHaveBeenCalledWith({ where: query.where });
  });
  it('uses stable largest-first ordering with unknown sizes last', async () => {
    await service.list(ctx, sourceListQuerySchema.parse({ sort: 'largest' }));
    expect(db.sourceVideo.findMany.mock.calls[0][0].orderBy).toEqual([{ sizeBytes: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]);
  });
  it('rejects invalid statuses, unbounded pages and arbitrary sort input', () => {
    for (const input of [{ status: 'MADE_UP' }, { pageSize: 10000 }, { sort: 'DROP TABLE' }, { search: 'x'.repeat(201) }]) expect(sourceListQuerySchema.safeParse(input).success).toBe(false);
  });
  it('returns not-found for absent or cross-workspace source detail', async () => {
    db.sourceVideo.findFirst.mockResolvedValue(null);
    await expect(service.get('foreign-source', ctx)).rejects.toMatchObject({ status: 404 });
    expect(db.sourceVideo.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-source', workspaceId: 'workspace-a', deletedAt: null } });
  });
});
