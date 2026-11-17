import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ publishingJob: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } }));
import { publishingJobsQuerySchema } from '../../apps/api/src/publishing/publishing-query';
import { PublishingService } from '../../apps/api/src/publishing/publishing.service';
import { monthWindow, localDateKey } from '../../apps/web/lib/calendar';
const from = '2026-11-01T00:00:00.000Z', to = '2026-12-01T00:00:00.000Z';
it('validates paired bounded date windows and actual database statuses', () => {
  expect(publishingJobsQuerySchema.parse({ scheduledFrom: from, scheduledTo: to }).pageSize).toBe(20);
  for (const query of [{ scheduledFrom: from }, { scheduledFrom: to, scheduledTo: from }, { scheduledFrom: from, scheduledTo: '2028-01-01T00:00:00Z' }, { status: 'made-up' }, { status: 'RETRYING' }]) expect(publishingJobsQuerySchema.safeParse(query).success).toBe(false);
  expect(publishingJobsQuerySchema.safeParse({ status: 'ELIGIBILITY_CHECK' }).success).toBe(true);
});
it('applies workspace ownership and the half-open schedule window to rows AND counts', async () => {
  const service = new PublishingService({} as never, {} as never, {} as never);
  await service.listJobs({ workspaceId: 'workspace-a' } as never, { page: 2, pageSize: 100, scheduledFrom: from, scheduledTo: to });
  const where = { workspaceId: 'workspace-a', scheduledFor: { gte: new Date(from), lt: new Date(to) } };
  expect(db.publishingJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 100, take: 100, orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }] }));
  expect(db.publishingJob.count).toHaveBeenCalledWith({ where });
});
it('handles leap years, local date keys and December rollover', () => {
  expect(monthWindow(2024, 1).days).toBe(29);
  const december = monthWindow(2026, 11);
  expect(new Date(december.to).getFullYear()).toBe(2027);
  expect(localDateKey(new Date(2026, 0, 3))).toBe('2026-01-03');
});
it('does not require public media storage for a YouTube byte upload', async () => {
  const accounts = { assertPublishable: vi.fn().mockResolvedValue({ id: 'account-a', platform: 'YOUTUBE', scopes: ['https://www.googleapis.com/auth/youtube.upload'], displayName: 'Owner channel' }), verify: vi.fn().mockResolvedValue({ healthy: true }) };
  const storage = { expectPublicHttps: vi.fn().mockResolvedValue({ ok: false, reason: 'local storage' }) };
  // Stop after eligibility/config validation: no DB/provider mutation is needed to prove the gate.
  const gate = new Error('configuration gate reached');
  const config = { resolveForProcessing: vi.fn().mockRejectedValue(gate) };
  const service = new PublishingService(accounts as never, storage as never, config as never);
  await expect(service.setEnabled({ connectedAccountId: 'account-a', enabled: true, youtube: { visibility: 'PRIVATE', categoryId: '22', madeForKids: false, defaultLanguage: 'en' } } as never, { workspaceId: 'workspace-a' } as never)).rejects.toBe(gate);
  expect(storage.expectPublicHttps).not.toHaveBeenCalled();
  expect(accounts.verify).toHaveBeenCalled();
});
