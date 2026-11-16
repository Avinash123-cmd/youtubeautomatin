import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
const db = vi.hoisted(() => ({
  telegramBotUpdate: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  $executeRaw: vi.fn().mockResolvedValue(1),
  user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  telegramConnectionToken: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('@clipforge/database', async (original) => ({ ...await original<typeof import('@clipforge/database')>(), prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }, appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { APP_URL: 'https://clips.example.test', TELEGRAM_WEBHOOK_SECRET: 'a-secure-webhook-secret-for-tests' } }));
import { TelegramAccountService } from '../../apps/api/src/auth/telegram-account.service';
import { AuthController } from '../../apps/api/src/auth/auth.controller';
const client = { sendMessage: vi.fn().mockResolvedValue({ delivered: true }) };
const accounts = new TelegramAccountService({ telegramClient: () => client } as never);
const token = 'a'.repeat(43);
const update = (text: string, type = 'private', from = 12345) => ({ update_id: 1, message: { text, from: { id: from, username: 'owner' }, chat: { id: 12345, type } } });
let connection: { id: string; userId: string; expiresAt: Date; consumedAt: Date | null };
beforeEach(() => {
  vi.clearAllMocks();
  connection = { id: 'token-row', userId: 'owner', expiresAt: new Date(Date.now() + 60_000), consumedAt: null };
  db.telegramConnectionToken.findUnique.mockImplementation(async () => connection);
  db.telegramConnectionToken.updateMany.mockImplementation(async () => { connection.consumedAt = new Date(); return { count: 1 }; });
  db.user.findUnique.mockResolvedValue({ status: 'ACTIVE', deletedAt: null, telegramUserId: null });
  db.user.findFirst.mockResolvedValue(null);
});
describe('Telegram bot linking (stubbed repository, no live Bot API)', () => {
  it('links a private sender after consuming the token, then refuses replay', async () => {
    await accounts.handleUpdate(update(`/start ${token}`));
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'owner' }, data: expect.objectContaining({ telegramUserId: '12345', telegramChatId: '12345', telegramUsername: 'owner' }) });
    await accounts.handleUpdate(update(`/start ${token}`));
    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls.at(-1)?.[1]).toContain('invalid, expired, already used');
  });
  it('rejects expired linking tokens', async () => {
    connection.expiresAt = new Date(0);
    await accounts.handleUpdate(update(`/start ${token}`));
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.telegramConnectionToken.updateMany).not.toHaveBeenCalled();
  });
  it('does not link when another request already consumed the token', async () => {
    db.telegramConnectionToken.updateMany.mockResolvedValue({ count: 0 });
    await accounts.handleUpdate(update(`/start ${token}`));
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('rejects duplicate Telegram account connections', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'different-account' });
    await accounts.handleUpdate(update(`/start ${token}`));
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('ignores group messages and mismatched senders', async () => {
    await accounts.handleUpdate(update(`/start ${token}`, 'group'));
    await accounts.handleUpdate(update(`/start ${token}`, 'private', 999));
    expect(db.telegramConnectionToken.findUnique).not.toHaveBeenCalled();
  });
  it('directs link and unlink commands to signed-in security settings', async () => {
    await accounts.handleUpdate(update('/link'));
    await accounts.handleUpdate(update('/unlink'));
    for (const [, text] of client.sendMessage.mock.calls) expect(text).toContain('https://clips.example.test/security');
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
describe('webhook boundary', () => {
  it('rejects missing and wrong secrets before reading the update', async () => {
    const handler = { handleUpdate: vi.fn() };
    const controller = new AuthController({} as never, {} as never, {} as never, {} as never, handler as never);
    for (const secret of ['', 'wrong-secret']) {
      await expect(controller.telegramBotWebhook(update('/start'), { get: () => secret } as unknown as Request)).rejects.toMatchObject({ status: 403 });
    }
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });
  it('accepts valid secret and validates the update before forwarding', async () => {
    const handler = { handleUpdate: vi.fn() };
    const controller = new AuthController({} as never, {} as never, {} as never, {} as never, handler as never);
    expect(await controller.telegramBotWebhook(update('/start'), { get: () => 'a-secure-webhook-secret-for-tests' } as unknown as Request)).toEqual({ ok: true });
    expect(handler.handleUpdate).toHaveBeenCalledOnce();
  });
});
