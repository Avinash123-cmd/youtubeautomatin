import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ user: { findUniqueOrThrow: vi.fn() }, otpChallenge: { findFirst: vi.fn() }, session: { findFirst: vi.fn() } }));
vi.mock('@clipforge/database', async original => ({ ...await original<typeof import('@clipforge/database')>(), prisma: db, appendAuditLog: vi.fn() }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
import { BotSecurityController } from '../../apps/api/src/auth/bot-security.controller';
import { PUBLIC_ROUTE } from '../../apps/api/src/common/decorators/auth.decorators';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
const sessions = { revokeAllForUser: vi.fn(), revoke: vi.fn() };
const otp = { verify: vi.fn(), issue: vi.fn() };
const controller = new BotSecurityController(sessions as never, {} as never, otp as never);
const ctx = { userId: 'owner' } as RequestContext;
const challengeId = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { vi.clearAllMocks(); });
describe('authenticated Telegram-only security actions', () => {
  it('does not expose OTP as public authentication or recovery', () => {
    for (const method of ['requestOtp', 'resendOtp', 'verifyOtp', 'link', 'unlink'] as const) expect(Reflect.getMetadata(PUBLIC_ROUTE, BotSecurityController.prototype[method])).not.toBe(true);
  });
  it('blocks unlinking the only identity', () => { expect(() => controller.unlink()).toThrow('Telegram is the only sign-in identity'); });
  it('refuses another user\'s OTP without checking the code', async () => {
    db.otpChallenge.findFirst.mockResolvedValue(null);
    await expect(controller.verifyOtp(ctx, { challengeId, code: '123456' })).rejects.toMatchObject({ status: 400 });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
  it('binds optional verification to Telegram session revocation, not login', async () => {
    db.otpChallenge.findFirst.mockResolvedValue({ id: challengeId }); otp.verify.mockResolvedValue({ ok: true });
    expect(await controller.verifyOtp(ctx, { challengeId, code: '123456' })).toEqual({ verified: true, sessionsRevoked: true });
    expect(db.otpChallenge.findFirst).toHaveBeenCalledWith({ where: { id: challengeId, userId: 'owner', purpose: 'SESSION_REVOCATION', channel: 'TELEGRAM' } });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('owner');
  });
  it('does not claim delivery if Telegram rejected a message', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({ id: 'owner', email: 'profile@example.test', telegramChatId: '12345' });
    otp.issue.mockResolvedValue({ delivered: false });
    await expect(controller.requestOtp(ctx, { get: () => 'test' } as never)).rejects.toMatchObject({ status: 503 });
  });
  it('does not revoke a different user\'s session', async () => {
    db.session.findFirst.mockResolvedValue(null);
    await expect(controller.revoke(ctx, challengeId)).rejects.toMatchObject({ status: 404 });
    expect(sessions.revoke).not.toHaveBeenCalled();
  });
  it('does not hide a database failure during revocation', async () => {
    const update = vi.spyOn(db.session, 'findFirst').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(controller.revoke(ctx, challengeId)).rejects.toThrow('database unavailable');
    update.mockRestore();
  });
});
