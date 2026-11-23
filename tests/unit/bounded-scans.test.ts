import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ connectedAccount: { findFirst: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
import { scanById } from '../../apps/api/src/common/services/scan-by-id';
import { eligiblePublishingAccounts } from '../../apps/api/src/workers/publishing-accounts';

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe('bounded keyset scans', () => {
  it('visits every row in ordered pages without retaining an unbounded result', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const fetch = vi.fn(async (after: string | undefined, take: number) => ids.filter(id => !after || id > after).slice(0, take).map(id => ({ id })));
    expect(await collect(scanById(fetch, 2))).toEqual(ids.map(id => ({ id })));
    expect(fetch.mock.calls).toEqual([[undefined, 2], ['b', 2], ['d', 2]]);
  });

  it('continues when the previous cursor row is deleted', async () => {
    let ids = ['a', 'b', 'c', 'd'];
    const fetch = vi.fn(async (after: string | undefined, take: number) => {
      if (after === 'b') ids = ids.filter(id => id !== 'b');
      return ids.filter(id => !after || id > after).slice(0, take).map(id => ({ id }));
    });
    expect((await collect(scanById(fetch, 2))).map(row => row.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(fetch.mock.calls).toEqual([[undefined, 2], ['b', 2], ['d', 2]]);
  });

  it('rejects invalid sizes and a non-advancing or oversized page', async () => {
    await expect(collect(scanById(async () => [], 0))).rejects.toThrow('page size');
    await expect(collect(scanById(async () => [{ id: 'a' }, { id: 'b' }], 1))).rejects.toThrow('too many');
    await expect(collect(scanById(async () => [{ id: 'a' }], 1))).rejects.toThrow('did not advance');
  });
});

describe('bounded publishing account selection', () => {
  it('looks up one deterministic eligible account per distinct platform within the workspace', async () => {
    db.connectedAccount.findFirst.mockReset()
      .mockResolvedValueOnce({ id: 'youtube-id', platform: 'YOUTUBE', publishingConfig: null })
      .mockResolvedValueOnce(null);
    const result = await eligiblePublishingAccounts('workspace-a', ['YOUTUBE', 'INSTAGRAM', 'YOUTUBE']);
    expect(result).toEqual([{ id: 'youtube-id', platform: 'YOUTUBE', publishingConfig: null }]);
    expect(db.connectedAccount.findFirst).toHaveBeenCalledTimes(2);
    expect(db.connectedAccount.findFirst).toHaveBeenNthCalledWith(1, {
      where: { workspaceId: 'workspace-a', platform: 'YOUTUBE', status: 'CONNECTED', publishingEnabled: true },
      select: { id: true, platform: true, publishingConfig: true }, orderBy: { id: 'asc' },
    });
    expect(db.connectedAccount.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { workspaceId: 'workspace-a', platform: 'INSTAGRAM', status: 'CONNECTED', publishingEnabled: true },
    }));
  });
});
