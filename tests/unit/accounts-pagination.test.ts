import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ connectedAccount: { findMany: vi.fn(), groupBy: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: database }));
vi.mock('../../apps/api/src/common/env', () => ({ env: {} }));
import { AccountsController } from '../../apps/api/src/accounts/accounts.controller';
import { AccountsService } from '../../apps/api/src/accounts/accounts.service';

const ctx = { workspaceId: 'workspace-a', userId: 'user-a' } as never;
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
const account = (id: string, platform: string) => ({
  id, platform, externalAccountId: id, displayName: id, username: null, avatarUrl: null, status: 'CONNECTED',
  scopes: [], tokenHealth: 'HEALTHY', tokenCheckedAt: null, publishingEnabled: true,
  publishingConfig: null, lastError: null, connectedAt: null, credential: null,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('workspace account pagination', () => {
  it('returns a bounded page and a cursor, plus eligible platforms from all pages', async () => {
    database.connectedAccount.findMany.mockResolvedValueOnce([account(ids[0], 'YOUTUBE'), account(ids[1], 'YOUTUBE'), account(ids[2], 'INSTAGRAM')]);
    database.connectedAccount.groupBy.mockResolvedValueOnce([{ platform: 'YOUTUBE' }, { platform: 'INSTAGRAM' }]);
    const service = new AccountsService({} as never, {} as never);
    const result = await service.list(ctx, { pageSize: 2 });
    expect(result.accounts.map(row => row.id)).toEqual([ids[0], ids[1]]);
    expect(result.nextCursor).toBe(ids[1]);
    expect(result.eligiblePublishingPlatforms).toEqual(['YOUTUBE', 'INSTAGRAM']);
    expect(database.connectedAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'workspace-a' }, orderBy: { id: 'asc' }, take: 3,
    }));
    expect(database.connectedAccount.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'workspace-a', status: 'CONNECTED', publishingEnabled: true }),
    }));
  });

  it('scopes subsequent keyset queries and does not need the previous row to exist', async () => {
    database.connectedAccount.findMany.mockResolvedValueOnce([account(ids[2], 'INSTAGRAM')]);
    database.connectedAccount.groupBy.mockResolvedValueOnce([{ platform: 'INSTAGRAM' }]);
    const result = await new AccountsService({} as never, {} as never).list(ctx, { pageSize: 2, cursor: ids[1] });
    expect(result.accounts.map(row => row.id)).toEqual([ids[2]]);
    expect(result.nextCursor).toBeNull();
    expect(database.connectedAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'workspace-a', id: { gt: ids[1] } }, take: 3,
    }));
  });

  it('rejects oversized and malformed pagination before querying', async () => {
    const service = new AccountsService({} as never, {} as never);
    await expect(service.list(ctx, { pageSize: 101 })).rejects.toMatchObject({ status: 400 });
    const controller = new AccountsController(service);
    expect(() => controller.list(ctx, { pageSize: '101' })).toThrow();
    expect(() => controller.list(ctx, { cursor: 'not-a-uuid' })).toThrow();
    expect(database.connectedAccount.findMany).not.toHaveBeenCalled();
  });
});
