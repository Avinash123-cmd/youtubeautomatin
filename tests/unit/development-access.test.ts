import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { developmentAuthBypassEnabled } from '@clipforge/shared-types';
const db = vi.hoisted(() => ({ workspaceMember: { findFirst: vi.fn() }, processingJob: { findFirst: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
import { developmentAccess } from '../../apps/api/src/common/development-access';
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const req = (path: string, method = 'GET', body = {}) => ({ path, method, body }) as Request;
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('AUTH_BYPASS', 'true');
  for (const key of ['VERCEL', 'RENDER', 'NETLIFY']) vi.stubEnv(key, '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:5432/dev_only');
  vi.stubEnv('AUTH_BYPASS_USER_ID', userId); vi.stubEnv('AUTH_BYPASS_WORKSPACE_ID', workspaceId);
  vi.clearAllMocks();
  db.workspaceMember.findFirst.mockResolvedValue({ userId, workspaceId, role: 'MEMBER', user: { email: 'developer@example.test', displayName: 'Existing developer' }, workspace: { name: 'Existing sandbox', slug: 'dev-auth-bypass-isolated', timezone: 'UTC' } });
});
afterEach(() => vi.unstubAllEnvs());
describe('development-only policy', () => {
  it.each(['production', '', 'staging'])('never enables for NODE_ENV=%s', env => { expect(developmentAuthBypassEnabled({ NODE_ENV: env, AUTH_BYPASS: 'true' })).toBe(false); });
  it.each(['false', 'TRUE', '1', ''])('requires exact explicit opt in %s', flag => { expect(developmentAuthBypassEnabled({ NODE_ENV: 'development', AUTH_BYPASS: flag })).toBe(false); });
  it('rejects production even with all identifiers configured', async () => {
    vi.stubEnv('NODE_ENV', 'production'); expect(await developmentAccess(req('/api/dashboard/summary'))).toBeNull(); expect(db.workspaceMember.findFirst).not.toHaveBeenCalled();
  });
  it('restores normal auth when false', async () => { vi.stubEnv('AUTH_BYPASS', 'false'); expect(await developmentAccess(req('/api/jobs'))).toBeNull(); });
  it('rejects hosted development runtimes', async () => { vi.stubEnv('RENDER', 'true'); expect(await developmentAccess(req('/api/jobs'))).toBeNull(); });
  it('never selects remote PostgreSQL/private workspace data', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@production.example/db');
    await expect(developmentAccess(req('/api/jobs'))).rejects.toMatchObject({ status: 503 }); expect(db.workspaceMember.findFirst).not.toHaveBeenCalled();
  });
  it('requires explicit identifiers and an active marked sandbox membership', async () => {
    vi.stubEnv('AUTH_BYPASS_USER_ID', ''); await expect(developmentAccess(req('/api/jobs'))).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('AUTH_BYPASS_USER_ID', userId); db.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(developmentAccess(req('/api/jobs'))).rejects.toMatchObject({ status: 503 });
  });
  it('uses existing scoped membership, creates no account/session, never reports authenticated', async () => {
    const result = await developmentAccess(req('/api/dashboard/summary'));
    expect(result).toMatchObject({ developmentBypass: true, userId, workspaceId, role: 'MEMBER', sessionId: '' }); expect(result).not.toHaveProperty('authenticated');
    expect(db.workspaceMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId, workspaceId, workspace: { deletedAt: null, slug: { startsWith: 'dev-auth-bypass-' } } }) }));
  });
  it.each(['/api/auth/security/overview', '/api/auth/telegram/webhook', '/api/auth/providers'])('does not bypass identity endpoints %s', async path => { expect(await developmentAccess(req(path))).toBeNull(); });
  it.each(['/api/publishing/jobs', '/api/accounts/youtube/connect', '/api/configuration', '/api/notifications/test'])('does not bypass integration/operator mutations %s', async path => { expect(await developmentAccess(req(path, 'POST'))).toBeNull(); });
  it('permits local processing writes but prohibits auto-publishing', async () => {
    await expect(developmentAccess(req('/api/jobs', 'POST', { configuration: { autoPublish: true } }))).rejects.toMatchObject({ status: 403 });
    expect(await developmentAccess(req('/api/jobs', 'POST', { configuration: { autoPublish: false } }))).toHaveProperty('developmentBypass', true);
  });
  it('does not allow trailing slashes to evade the auto-publishing restriction', async () => {
    await expect(developmentAccess(req('/api/jobs/', 'POST', { configuration: { autoPublish: true } }))).rejects.toMatchObject({ status: 403 });
  });
  it('blocks retry of a previously auto-publishing job', async () => {
    db.processingJob.findFirst.mockResolvedValue({ configuration: { autoPublish: true } });
    await expect(developmentAccess(req('/api/jobs/job-id/retry', 'POST'))).rejects.toMatchObject({ status: 403 });
  });
});
