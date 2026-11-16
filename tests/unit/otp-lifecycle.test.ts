import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), user: { findUnique: vi.fn() }, otpChallenge: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) } }));
import { OtpService } from '../../apps/api/src/auth/otp.service';
const id = '1b726681-2718-4545-8874-0758f0303f12';
const email = { send: vi.fn() };
const service = new OtpService(email as never);
let row: { id: string; codeHash: string; expiresAt: Date; consumedAt: Date | null; attempts: number; maxAttempts: number };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = 'test-secret-with-at-least-32-characters';
  row = { id, codeHash: OtpService.hashCode(id, '123456'), expiresAt: new Date(Date.now() + 60_000), consumedAt: null, attempts: 0, maxAttempts: 5 };
  db.otpChallenge.findUnique.mockImplementation(async () => row);
  db.otpChallenge.update.mockImplementation(async () => ({ ...row, attempts: ++row.attempts }));
  db.otpChallenge.updateMany.mockImplementation(async () => { row.consumedAt = new Date(); return { count: 1 }; });
});
describe('OTP lifecycle (transactional repository stub, not live PostgreSQL)', () => {
  it('succeeds once, rejects replay', async () => {
    expect(await service.verify(id, '123456')).toEqual({ ok: true });
    expect(await service.verify(id, '123456')).toMatchObject({ ok: false, reason: 'CONSUMED' });
  });
  it('rejects expired codes', async () => {
    row.expiresAt = new Date(0);
    expect(await service.verify(id, '123456')).toMatchObject({ ok: false, reason: 'EXPIRED' });
  });
  it('counts wrong and malformed guesses and locks after five attempts', async () => {
    for (let i = 0; i < 5; i++) expect(await service.verify(id, i % 2 ? '000000' : 'bad')).toMatchObject({ ok: false, reason: 'MISMATCH', attemptsRemaining: 4 - i });
    expect(await service.verify(id, '123456')).toMatchObject({ ok: false, reason: 'TOO_MANY_ATTEMPTS' });
  });
  it('rejects malformed IDs without querying the database', async () => {
    expect(await service.verify('bad', '123456')).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('never sends codes to a caller-supplied unlinked Telegram chat', async () => {
    db.user.findUnique.mockResolvedValue({ telegramUserId: null });
    await expect(service.issue({ userId: id, email: '', purpose: 'LOGIN', channel: 'TELEGRAM', telegramChatId: '12345' })).rejects.toThrow();
    expect(db.otpChallenge.create).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });
  it('enforces resend cooldown even on a consumed challenge', async () => {
    db.otpChallenge.findFirst.mockResolvedValue({ sentAt: new Date(), consumedAt: new Date() });
    await expect(service.issue({ userId: id, email: 'a@example.com', purpose: 'LOGIN', channel: 'EMAIL' })).rejects.toMatchObject({ status: 429 });
    expect(db.otpChallenge.create).not.toHaveBeenCalled();
  });
  it('invalidates old codes and persists only the hash before delivery', async () => {
    db.otpChallenge.findFirst.mockResolvedValue(null);
    db.otpChallenge.create.mockImplementation(async ({ data }) => { expect(data.codeHash).toMatch(/^[a-f0-9]{64}$/); expect(data.codeHash).not.toBe('pending'); return data; });
    email.send.mockResolvedValue({ delivered: true, error: null });
    const result = await service.issue({ userId: id, email: 'a@example.com', purpose: 'LOGIN', channel: 'EMAIL' });
    expect(result.delivered).toBe(true);
    expect(db.otpChallenge.updateMany).toHaveBeenCalled();
    expect(result).not.toHaveProperty('code');
  });
});

describe('dual-channel verification', () => {
  const otherId = '2b726681-2718-4545-8874-0758f0303f12';
  it('does not consume the first correct code when the second is wrong', async () => {
    const other = { ...row, id: otherId, codeHash: OtpService.hashCode(otherId, '654321') };
    db.otpChallenge.findUnique.mockImplementation(async ({ where }) => where.id === id ? row : other);
    expect(await service.verifyMany([{ challengeId: id, code: '123456' }, { challengeId: otherId, code: '000000' }])).toMatchObject({ ok: false, reason: 'MISMATCH' });
    expect(db.otpChallenge.updateMany).not.toHaveBeenCalled();
  });
  it('consumes both codes with one update only after both verify', async () => {
    const other = { ...row, id: otherId, codeHash: OtpService.hashCode(otherId, '654321') };
    db.otpChallenge.findUnique.mockImplementation(async ({ where }) => where.id === id ? row : other);
    expect(await service.verifyMany([{ challengeId: id, code: '123456' }, { challengeId: otherId, code: '654321' }])).toEqual({ ok: true });
    expect(db.otpChallenge.updateMany).toHaveBeenCalledTimes(1);
    expect(db.otpChallenge.updateMany).toHaveBeenCalledWith({ where: { id: { in: [id, otherId] } }, data: { consumedAt: expect.any(Date) } });
  });
  it('rejects repeated IDs before locking', async () => {
    expect(await service.verifyMany([{ challengeId: id, code: '123456' }, { challengeId: id, code: '123456' }])).toMatchObject({ ok: false });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
