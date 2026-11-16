import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
const db = vi.hoisted(() => ({ user: { update: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db, appendAuditLog: vi.fn() }));
import { AuthService } from '../../apps/api/src/auth/auth.service';
const sessions = { create: vi.fn() };
const firebase = { verifyIdToken: vi.fn() };
const security = { beginStepUp: vi.fn() };
const service = new AuthService(sessions as never, firebase as never, security as never);
const req = { get: () => 'test' } as unknown as Request;
const challenge = { otpRequired: true, mode: 'EMAIL', challenges: [] };
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  security.beginStepUp.mockResolvedValue(challenge);
  firebase.verifyIdToken.mockResolvedValue({ uid: 'verified-google-user' });
});
describe('providers cannot bypass local account second-factor policy', () => {
  it('returns a Google step-up instead of a session', async () => {
    vi.spyOn(service, 'resolveFirebaseUser').mockResolvedValue({ id: 'user', otpMode: 'EMAIL' } as never);
    expect(await service.loginWithFirebase('verified-token', req)).toBe(challenge);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('returns a Telegram step-up instead of a session', async () => {
    vi.spyOn(service, 'resolveTelegramUser').mockResolvedValue({ id: 'user', otpMode: 'EMAIL' } as never);
    expect(await service.loginWithTelegram({ id: '123', name: null, username: null, picture: null }, req)).toBe(challenge);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
