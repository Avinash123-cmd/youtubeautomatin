import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ usageRecord: { findMany: vi.fn(), groupBy: vi.fn() }, $queryRaw: vi.fn() }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
vi.mock('../../apps/api/src/common/env', () => ({ env: {
  PRICE_GEMINI_INPUT_PER_1K_TOKENS: 0, PRICE_GEMINI_OUTPUT_PER_1K_TOKENS: 0,
  PRICE_VISION_INPUT_PER_1K_TOKENS: 0, PRICE_VISION_OUTPUT_PER_1K_TOKENS: 0,
  PRICE_TRANSCRIPTION_PER_SECOND: 0, PRICE_RENDER_PER_SECOND: 0, PRICE_STORAGE_PER_GB_MONTH: 1,
  PRICE_PUBLISH_CALL: 0,
} }));
import { UsageService } from '../../apps/api/src/usage/usage.service';

beforeEach(() => vi.clearAllMocks());

describe('bounded usage aggregates', () => {
  const workspace = '00000000-0000-4000-8000-000000000001';
  const query = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-03T23:59:59.000Z' };

  it('computes totals and unpriced counts from grouped rows, without loading the ledger', async () => {
    db.usageRecord.groupBy.mockResolvedValueOnce([
      { kind: 'gemini_tokens', _sum: { quantity: 1000, costUsd: 0.012345 }, _count: { _all: 2, costUsd: 1 } },
      { kind: 'storage_bytes', _sum: { quantity: 2048, costUsd: null }, _count: { _all: 2, costUsd: 0 } },
      { kind: 'render_seconds', _sum: { quantity: 5.1234567, costUsd: 0 }, _count: { _all: 1, costUsd: 1 } },
    ]);
    db.$queryRaw.mockResolvedValueOnce([{ bytes: 1024 }]);
    const result = await new UsageService().summary(workspace, query);
    expect(result.totals).toMatchObject({ records: 5, unpricedRecords: 3, costUsd: 0.012345, tokens: 1000, renderSeconds: 5.123457, storageBytesWritten: 2048 });
    expect(result.byKind.find(group => group.kind === 'gemini_tokens')).toMatchObject({ records: 2, unpricedRecords: 1, costUsd: 0.012345 });
    expect(result.storage.bytesStoredNow).toBe(1024);
    expect(db.usageRecord.findMany).not.toHaveBeenCalled();
    expect(db.usageRecord.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: workspace }) }));
    expect(db.$queryRaw).toHaveBeenCalledTimes(1); // storage estimate is not fetched twice
    const [sql, workspaceParam] = db.$queryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('DISTINCT ON');
    expect(sql.join('?')).not.toContain(workspace);
    expect(workspaceParam).toBe(workspace);
  });

  it('handles an empty ledger', async () => {
    db.usageRecord.groupBy.mockResolvedValueOnce([]);
    db.$queryRaw.mockResolvedValueOnce([{ bytes: 0 }]);
    const result = await new UsageService().summary(workspace, query);
    expect(result.totals.records).toBe(0);
    expect(result.byKind).toEqual([]);
    expect(result.storage.bytesStoredNow).toBe(0);
  });

  it('combines database day/kind buckets and keeps workspace and dates parameterized', async () => {
    db.$queryRaw.mockResolvedValueOnce([
      { date: '2026-11-01', kind: 'gemini_tokens', costUsd: 0.01, records: 3 },
      { date: '2026-11-01', kind: 'render_seconds', costUsd: 0.02, records: 1 },
      { date: '2026-11-02', kind: 'render_seconds', costUsd: 0.03, records: 2 },
    ]);
    const result = await new UsageService().daily(workspace, query);
    expect(result.days).toEqual([
      { date: '2026-11-01', costUsd: 0.03, records: 4, byKind: { gemini_tokens: 0.01, render_seconds: 0.02 } },
      { date: '2026-11-02', costUsd: 0.03, records: 2, byKind: { render_seconds: 0.03 } },
    ]);
    const [sql, workspaceParam, fromParam, toParam] = db.$queryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('GROUP BY');
    expect(sql.join('?')).not.toContain(workspace);
    expect(workspaceParam).toBe(workspace);
    expect(fromParam).toBe(new Date(query.from).toISOString());
    expect(toParam).toBe(new Date(query.to).toISOString());
    expect(sql.join('?')).toContain("AT TIME ZONE 'UTC'");
    expect(db.usageRecord.findMany).not.toHaveBeenCalled();
  });
});
