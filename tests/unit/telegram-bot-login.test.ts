import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  telegramBotLoginChallenge: { upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  telegramBotUpdate: { createMany: vi.fn() },
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  workspace: { create: vi.fn() }, workspaceMember: { create: vi.fn(), findFirst: vi.fn() },
  session: { create: vi.fn() }, auditLog: { create: vi.fn() }, loginEvent: { create: vi.fn() },
}));
const transaction = vi.hoisted(() => vi.fn());
vi.mock('@clipforge/database', async original => ({ ...await original<typeof import('@clipforge/database')>(), prisma: { ...db, $transaction: transaction } }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { TELEGRAM_BOT_TOKEN: 'test-only-token', TELEGRAM_BOT_USERNAME: 'ClipForgeTestBot', TELEGRAM_WEBHOOK_SECRET: 'test-only-webhook-secret', TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS: 300, SESSION_SECRET: 'test-only-session-secret-at-least-32-characters', TIMEZONE: 'UTC' } }));
import { TelegramBotLoginService, loginHash } from '../../apps/api/src/auth/telegram-bot-login.service';
import { SessionService } from '../../apps/api/src/auth/session.service';
import type { Request } from 'express';
let row: Record<string, any>;
const user = { id: 'existing-user', telegramUserId: '12345', telegramLinkedAt: new Date(), status: 'ACTIVE', deletedAt: null };
const service = new TelegramBotLoginService(new SessionService());
const req = { ip: '127.0.0.1', get: () => 'unit-test-browser' } as unknown as Request;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_SECRET', 'test-only-session-secret-at-least-32-characters');
  row = { id: 'challenge', browserHash: loginHash('b'.repeat(43)), tokenHash: loginHash('t'.repeat(43)), expiresAt: new Date(Date.now() + 300000), approvedAt: null, consumedAt: null, userId: null };
  transaction.mockImplementation(async fn => fn(db));
  db.telegramBotLoginChallenge.findUnique.mockImplementation(async () => row);
  db.telegramBotLoginChallenge.updateMany.mockImplementation(async ({ data }) => { Object.assign(row, data); return { count: 1 }; });
  db.telegramBotLoginChallenge.upsert.mockResolvedValue(row);
  db.telegramBotUpdate.createMany.mockResolvedValue({ count: 1 });
  db.user.findUnique.mockResolvedValue(user);
  db.user.update.mockResolvedValue(user);
  db.user.create.mockImplementation(async ({ data }) => ({ ...user, ...data }));
  db.workspace.create.mockResolvedValue({ id: 'new-workspace' });
  db.workspaceMember.findFirst.mockResolvedValue({ workspaceId: 'existing-workspace' });
  db.session.create.mockImplementation(async ({ data }) => data);
});

describe('bot login security (repository stubs; no real PostgreSQL race proof)', () => {
  it('generates independent random browser and deep-link secrets; stores hashes only', async () => {
    const result = await service.create();
    const token = new URL(result.deepLink).searchParams.get('start')!.slice(6);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.browser).not.toBe(token);
    const stored = db.telegramBotLoginChallenge.upsert.mock.calls[0][0].create;
    expect(stored.tokenHash).toBe(loginHash(token));
    expect(stored.browserHash).toBe(loginHash(result.browser));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(result.browser);
    expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(290000);
  });
  it('rotates one browser row instead of leaving repeated active challenges', async () => {
    const result = await service.create('b'.repeat(43));
    expect(result.browser).toBe('b'.repeat(43));
    expect(db.telegramBotLoginChallenge.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { browserHash: row.browserHash }, update: expect.objectContaining({ approvedAt: null, consumedAt: null, userId: null }) }));
  });
  it('rejects missing browser handoff and unapproved/expired challenges', async () => {
    await expect(service.complete(undefined, req)).rejects.toMatchObject({ status: 400 });
    await expect(service.complete('b'.repeat(43), req)).rejects.toMatchObject({ status: 400 });
    row.approvedAt = new Date(); row.userId = user.id; row.expiresAt = new Date(0);
    await expect(service.complete('b'.repeat(43), req)).rejects.toMatchObject({ status: 400 });
    expect(db.session.create).not.toHaveBeenCalled();
  });
  it('deduplicates authenticated update IDs before identity resolution', async () => {
    db.telegramBotUpdate.createMany.mockResolvedValue({ count: 0 });
    await service.approve(7, 't'.repeat(43), { id: 12345 });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.telegramBotUpdate.createMany).toHaveBeenCalledWith({ data: { id: 7n }, skipDuplicates: true });
  });
  it.each(['expired', 'approved', 'consumed', 'missing'])('does not resolve identity for %s challenges', async state => {
    if (state === 'expired') row.expiresAt = new Date(0);
    if (state === 'approved') row.approvedAt = new Date();
    if (state === 'consumed') row.consumedAt = new Date();
    if (state === 'missing') db.telegramBotLoginChallenge.findUnique.mockResolvedValue(null);
    await service.approve(7, 't'.repeat(43), { id: 12345 });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
  it('resolves existing bot identity without creating another account or email matching', async () => {
    await service.approve(7, 't'.repeat(43), { id: 12345, username: 'verified' });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { telegramUserId: '12345' } });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.workspace.create).not.toHaveBeenCalled();
    expect(row.userId).toBe(user.id);
    expect(row.approvedAt).toBeInstanceOf(Date);
  });
  it('provisions a new user and OWNER membership transactionally without a password', async () => {
    db.user.findUnique.mockResolvedValue(null);
    await service.approve(7, 't'.repeat(43), { id: 12345, first_name: 'New owner' });
    expect(db.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ passwordHash: null, telegramUserId: '12345', telegramChatId: '12345' }) });
    expect(db.workspaceMember.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'OWNER', workspaceId: 'new-workspace' }) });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it('does not approve disabled accounts or bot senders', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, status: 'DISABLED' });
    await service.approve(7, 't'.repeat(43), { id: 12345 });
    expect(db.telegramBotLoginChallenge.updateMany).not.toHaveBeenCalled();
    await service.approve(8, 't'.repeat(43), { id: 12345, is_bot: true });
    expect(db.telegramBotUpdate.createMany).toHaveBeenCalledTimes(1);
  });
  it('atomically consumes handoff and uses the existing session crypto; rejects replay', async () => {
    row.approvedAt = new Date(); row.userId = user.id;
    const result = await service.complete('b'.repeat(43), req);
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = db.session.create.mock.calls[0][0].data;
    expect(stored.tokenHash).not.toBe(result.rawToken);
    expect(stored.csrfHash).not.toBe(result.csrfToken);
    expect(stored.userId).toBe(user.id);
    expect(row.consumedAt).toBeInstanceOf(Date);
    await expect(service.complete('b'.repeat(43), req)).rejects.toMatchObject({ status: 400 });
    expect(db.session.create).toHaveBeenCalledTimes(1);
  });
  it('does not return any handoff secret or account identity before approval in status', async () => {
    const result = await service.status('b'.repeat(43));
    expect(result).toMatchObject({ state: 'WAITING_FOR_TELEGRAM', identity: null });
    expect(JSON.stringify(result)).not.toContain('tokenHash');
    expect(await service.status()).toEqual({ state: 'IDLE' });
  });
  it('bounds serialization retries', async () => {
    transaction.mockRejectedValue({ code: 'P2034' });
    await expect(service.approve(7, 't'.repeat(43), { id: 12345 })).rejects.toMatchObject({ code: 'P2034' });
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
