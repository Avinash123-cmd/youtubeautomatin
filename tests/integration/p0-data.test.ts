/** Real PostgreSQL coverage for account keyset pagination and usage aggregation. */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/common/env', () => ({ env: {
  PRICE_GEMINI_INPUT_PER_1K_TOKENS: 0, PRICE_GEMINI_OUTPUT_PER_1K_TOKENS: 0,
  PRICE_VISION_INPUT_PER_1K_TOKENS: 0, PRICE_VISION_OUTPUT_PER_1K_TOKENS: 0,
  PRICE_TRANSCRIPTION_PER_SECOND: 0, PRICE_RENDER_PER_SECOND: 0, PRICE_STORAGE_PER_GB_MONTH: 1,
  PRICE_PUBLISH_CALL: 0,
} }));

let prisma: typeof import('@clipforge/database').prisma;
let usage: InstanceType<typeof import('../../apps/api/src/usage/usage.service').UsageService>;
let accounts: InstanceType<typeof import('../../apps/api/src/accounts/accounts.service').AccountsService>;
let workspaceId = '';
let otherWorkspaceId = '';
const [firstId, secondId] = [randomUUID(), randomUUID()].sort();

beforeAll(async () => {
  if (existsSync('.env')) process.loadEnvFile('.env');
  ({ prisma } = await import('@clipforge/database'));
  const { UsageService } = await import('../../apps/api/src/usage/usage.service');
  const { AccountsService } = await import('../../apps/api/src/accounts/accounts.service');
  usage = new UsageService();
  accounts = new AccountsService({} as never, {} as never);
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({ data: { name: 'P0 data test', slug: `p0-${suffix}`, timezone: 'UTC' } });
  workspaceId = workspace.id;
  const other = await prisma.workspace.create({ data: { name: 'P0 other tenant', slug: `p0-other-${suffix}`, timezone: 'UTC' } });
  otherWorkspaceId = other.id;
  const beforeMidnight = new Date('2026-01-01T23:59:00.000Z');
  const afterMidnight = new Date('2026-01-02T00:01:00.000Z');
  await prisma.usageRecord.createMany({ data: [
    { workspaceId, kind: 'storage_bytes', unit: 'bytes', quantity: 10, metadata: { sourceVideoId: 'source-a' }, recordedAt: beforeMidnight },
    { workspaceId, kind: 'storage_bytes', unit: 'bytes', quantity: 20, metadata: { sourceVideoId: 'source-a' }, recordedAt: afterMidnight },
    { workspaceId, kind: 'storage_bytes', unit: 'bytes', quantity: 3, recordedAt: afterMidnight },
    { workspaceId, kind: 'storage_bytes', unit: 'bytes', quantity: 4, recordedAt: afterMidnight },
    { workspaceId, kind: 'gemini_tokens', unit: 'tokens', quantity: 100, costUsd: 0.01, recordedAt: beforeMidnight },
    { workspaceId, kind: 'gemini_tokens', unit: 'tokens', quantity: 200, recordedAt: afterMidnight },
    { workspaceId, kind: 'render_seconds', unit: 'seconds', quantity: 3, costUsd: 0.02, recordedAt: afterMidnight },
    { workspaceId: otherWorkspaceId, kind: 'storage_bytes', unit: 'bytes', quantity: 999, metadata: { sourceVideoId: 'source-a' }, recordedAt: afterMidnight },
    { workspaceId: otherWorkspaceId, kind: 'render_seconds', unit: 'seconds', quantity: 999, costUsd: 5, recordedAt: afterMidnight },
  ] });
  await prisma.connectedAccount.createMany({ data: [
    { id: firstId, workspaceId, platform: 'YOUTUBE', externalAccountId: `yt-${suffix}`, displayName: 'YT', status: 'CONNECTED', publishingEnabled: true },
    { id: secondId, workspaceId, platform: 'INSTAGRAM', externalAccountId: `ig-${suffix}`, displayName: 'IG', status: 'CONNECTED', publishingEnabled: true },
    { workspaceId: otherWorkspaceId, platform: 'YOUTUBE', externalAccountId: `other-${suffix}`, displayName: 'Other', status: 'CONNECTED', publishingEnabled: true },
  ] });
});

afterAll(async () => {
  if (prisma) {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
    if (otherWorkspaceId) await prisma.workspace.delete({ where: { id: otherWorkspaceId } });
    await prisma.$disconnect();
  }
});

describe('PostgreSQL aggregation and pagination', () => {
  it('keeps totals, null-cost counts, latest storage rows and workspace isolation', async () => {
    const result = await usage.summary(workspaceId, { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' });
    expect(result.totals).toMatchObject({ records: 7, unpricedRecords: 5, costUsd: 0.03, tokens: 300, storageBytesWritten: 37 });
    expect(result.storage.bytesStoredNow).toBe(27);
    expect(result.byKind.find(row => row.kind === 'gemini_tokens')).toMatchObject({ records: 2, unpricedRecords: 1, costUsd: 0.01 });
  });

  it('buckets UTC dates and excludes other workspaces and null costs', async () => {
    const result = await usage.daily(workspaceId, { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' });
    expect(result.days).toEqual([
      { date: '2026-01-01', costUsd: 0.01, records: 1, byKind: { gemini_tokens: 0.01 } },
      { date: '2026-01-02', costUsd: 0.02, records: 1, byKind: { render_seconds: 0.02 } },
    ]);
    // Tight UTC bounds must be unaffected by a non-UTC PostgreSQL session.
    const bounded = await usage.daily(workspaceId, { from: '2026-01-01T23:58:00Z', to: '2026-01-02T00:00:00Z' });
    expect(bounded.days).toEqual([
      { date: '2026-01-01', costUsd: 0.01, records: 1, byKind: { gemini_tokens: 0.01 } },
    ]);
  });

  it('pages within a workspace even if the prior cursor row is deleted', async () => {
    const ctx = { workspaceId } as never;
    const first = await accounts.list(ctx, { pageSize: 1 });
    expect(first.accounts.map(row => row.id)).toEqual([firstId]);
    expect(first.nextCursor).toBe(firstId);
    expect(first.eligiblePublishingPlatforms.sort()).toEqual(['INSTAGRAM', 'YOUTUBE']);
    const { eligiblePublishingAccounts } = await import('../../apps/api/src/workers/publishing-accounts');
    const selected = await eligiblePublishingAccounts(workspaceId, ['YOUTUBE', 'INSTAGRAM']);
    expect(selected.map(row => row.id).sort()).toEqual([firstId, secondId]);
    await prisma.connectedAccount.delete({ where: { id: firstId } });
    const second = await accounts.list(ctx, { pageSize: 1, cursor: firstId });
    expect(second.accounts.map(row => row.id)).toEqual([secondId]);
    expect(second.nextCursor).toBeNull();
  });
});
