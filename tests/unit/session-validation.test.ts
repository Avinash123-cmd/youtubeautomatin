import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
const db = vi.hoisted(() => ({ session: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock('@clipforge/database', async (original) => ({ ...await original<typeof import('@clipforge/database')>(), prisma: db }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters' } }));
import { SessionService } from '../../apps/api/src/auth/session.service';
import { createHash } from 'node:crypto';
const req = {} as Request;
const makeRow = () => ({ id: 'existing-session', userId: 'user', csrfHash: '', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date(), user: { status: 'ACTIVE', deletedAt: null, email: 'user@example.test', displayName: 'Existing user', memberships: [{ role: 'OWNER', workspaceId: 'workspace', workspace: { name: 'Existing workspace', slug: 'existing', timezone: 'Asia/Kolkata' } }] } });
beforeEach(() => { vi.clearAllMocks(); process.env.SESSION_SECRET = 'test-only-session-secret-with-at-least-32-characters'; });
describe('session continuity and expiry (repository stub)', () => {
  it('retains an active existing session and workspace identity', async () => {
    db.session.findUnique.mockResolvedValue(makeRow());
    expect(await new SessionService().validate('existing-cookie', req)).toMatchObject({ sessionId: 'existing-session', workspaceId: 'workspace', role: 'OWNER' });
  });
  it('rejects expired and exactly-expired sessions', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (const expiry of [0, now]) {
        db.session.findUnique.mockResolvedValue({ ...makeRow(), expiresAt: new Date(expiry) });
        expect(await new SessionService().validate('cookie', req)).toBeNull();
      }
    } finally { vi.restoreAllMocks(); }
  });
  it('rejects revoked sessions and disabled users', async () => {
    db.session.findUnique.mockResolvedValueOnce({ ...makeRow(), revokedAt: new Date() });
    expect(await new SessionService().validate('cookie', req)).toBeNull();
    const row = makeRow(); row.user.status = 'DISABLED';
    db.session.findUnique.mockResolvedValueOnce(row);
    expect(await new SessionService().validate('cookie', req)).toBeNull();
  });
  it('continues accepting legacy random session CSRF tokens after restart', async () => {
    const token = 'legacy-random-csrf-token';
    db.session.findUnique.mockResolvedValue({ csrfHash: createHash('sha256').update(token).digest('hex'), revokedAt: null });
    expect(await new SessionService().verifyCsrf('existing-session', token)).toBe(true);
  });
  it('rejects wrong legacy CSRF tokens', async () => {
    db.session.findUnique.mockResolvedValue({ csrfHash: createHash('sha256').update('correct-token').digest('hex'), revokedAt: null });
    expect(await new SessionService().verifyCsrf('existing-session', 'wrong-token')).toBe(false);
  });
});
