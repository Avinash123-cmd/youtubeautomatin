import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
const db = vi.hoisted(() => ({ otpChallenge: { findMany: vi.fn() }, user: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db, appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
import { SecurityService } from '../../apps/api/src/auth/security.service';
const otp = { verifyMany: vi.fn(), issue: vi.fn() };
const service = new SecurityService({} as never, otp as never, {} as never, {} as never);
const req = { ip: '127.0.0.1', get: () => 'test' } as unknown as Request;
const challenges = [
  { id: 'email', userId: 'user', purpose: 'LOGIN', channel: 'EMAIL' },
  { id: 'telegram', userId: 'user', purpose: 'LOGIN', channel: 'TELEGRAM' },
];
beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ id: 'user', status: 'ACTIVE', deletedAt: null, otpMode: 'DUAL' });
});
describe('server-enforced step-up policy', () => {
  it('rejects an email-only submission for DUAL without consuming a code', async () => {
    db.otpChallenge.findMany.mockResolvedValue([challenges[0]]);
    await expect(service.completeStepUp({ challengeIds: ['email'], codes: ['123456'] }, req)).rejects.toMatchObject({ response: { code: 'OTP_POLICY_MISMATCH' } });
    expect(otp.verifyMany).not.toHaveBeenCalled();
  });
  it('rejects two challenges for the same channel', async () => {
    db.otpChallenge.findMany.mockResolvedValue([challenges[0], { ...challenges[0], id: 'other' }]);
    await expect(service.completeStepUp({ challengeIds: ['email', 'other'], codes: ['123456', '123456'] }, req)).rejects.toThrow();
    expect(otp.verifyMany).not.toHaveBeenCalled();
  });
  it('rejects challenges from different accounts', async () => {
    db.otpChallenge.findMany.mockResolvedValue([challenges[0], { ...challenges[1], userId: 'attacker' }]);
    await expect(service.completeStepUp({ challengeIds: ['email', 'telegram'], codes: ['123456', '123456'] }, req)).rejects.toThrow();
    expect(otp.verifyMany).not.toHaveBeenCalled();
  });
  it('rejects recovery-purpose challenges as login credentials', async () => {
    db.otpChallenge.findMany.mockResolvedValue([{ ...challenges[0], purpose: 'PASSWORD_RESET' }]);
    await expect(service.completeStepUp({ challengeIds: ['email'], codes: ['123456'] }, req)).rejects.toThrow();
    expect(otp.verifyMany).not.toHaveBeenCalled();
  });
  it('rejects disabled accounts before checking codes', async () => {
    db.otpChallenge.findMany.mockResolvedValue(challenges);
    db.user.findUnique.mockResolvedValue({ id: 'user', status: 'DISABLED', otpMode: 'DUAL' });
    await expect(service.completeStepUp({ challengeIds: ['email', 'telegram'], codes: ['123456', '123456'] }, req)).rejects.toMatchObject({ status: 403 });
    expect(otp.verifyMany).not.toHaveBeenCalled();
  });
});

describe('recovery request enumeration resistance', () => {
  it('returns the same response for unknown accounts and delivery failures', async () => {
    db.user.findUnique.mockResolvedValueOnce(null);
    expect(await service.forgotPassword('unknown@example.test', req)).toEqual({ requested: true });
    db.user.findUnique.mockResolvedValueOnce({ id: 'user', status: 'ACTIVE', email: 'real@example.test', otpMode: 'EMAIL' });
    otp.issue.mockRejectedValueOnce(new Error('delivery unavailable'));
    expect(await service.forgotPassword('real@example.test', req)).toEqual({ requested: true });
  });
  it('falls back to email when a legacy Telegram chat has not activated the bot', async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: 'user', status: 'ACTIVE', email: 'real@example.test', otpMode: 'TELEGRAM', telegramChatId: '12345', telegramUserId: null });
    otp.issue.mockResolvedValueOnce({ delivered: true });
    await service.forgotPassword('real@example.test', req);
    expect(otp.issue).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EMAIL' }));
  });
});
