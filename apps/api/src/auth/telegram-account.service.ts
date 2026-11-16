import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { appendAuditLog, prisma } from '@clipforge/database';
import { env } from '../common/env';
import { NotificationsService } from '../notifications/notifications.service';

const CONNECTION_TTL_MS = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export interface TelegramBotUpdate {
  update_id: number;
  message?: {
    text?: string;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
  };
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class TelegramAccountService {
  constructor(private readonly notifications: NotificationsService) {}

  get botUsername(): string | null {
    return env.TELEGRAM_BOT_USERNAME ?? null;
  }

  async startConnection(userId: string): Promise<{ deepLink: string; expiresAt: string }> {
    const username = env.TELEGRAM_BOT_USERNAME;
    if (!username || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !this.notifications.telegramClient()) {
      throw new ServiceUnavailableException({
        code: 'TELEGRAM_BOT_NOT_CONFIGURED',
        message: 'Telegram account connection is not configured. Ask an administrator to configure the Telegram bot and webhook.',
      });
    }

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CONNECTION_TTL_MS);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, deletedAt: true } });
      if (!user || user.deletedAt || user.status !== 'ACTIVE') {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This account is not active.' });
      }
      await tx.telegramConnectionToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
      });
      // A newer request invalidates outstanding links for this account.
      await tx.telegramConnectionToken.updateMany({
        where: { userId, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      await tx.telegramConnectionToken.create({ data: { userId, tokenHash: hashToken(rawToken), expiresAt } });
    }, { isolationLevel: 'Serializable' });

    return { deepLink: `https://t.me/${username}?start=${rawToken}`, expiresAt: expiresAt.toISOString() };
  }

  /** The webhook secret is checked by the controller before any update reaches this method. */
  async handleUpdate(update: TelegramBotUpdate): Promise<void> {
    const message = update.message;
    const sender = message?.from;
    const chat = message?.chat;
    const text = message?.text?.trim();
    if (!message || !sender || !chat || !text || chat.type !== 'private' || sender.id !== chat.id) return;

    const [rawCommand, argument] = text.split(/\s+/, 2);
    const command = rawCommand.toLowerCase().split('@')[0];
    const chatId = String(chat.id);

    if (command === '/start') {
      if (argument && TOKEN_PATTERN.test(argument)) {
        await this.completeConnection(argument, String(sender.id), chatId, sender.username ?? null);
        return;
      }
      await this.reply(chatId, 'Welcome to ClipForge. To connect this Telegram account, start the connection from your signed-in ClipForge settings page. Use /help to see commands.');
      return;
    }

    if (command === '/help') {
      await this.reply(chatId, 'ClipForge bot commands:\n/status — check the account connection\n/connect — open ClipForge settings to start a secure connection\n/disconnect — remove this bot connection');
      return;
    }

    if (command === '/connect') {
      await this.reply(chatId, `To connect, sign in to ClipForge and create a one-time link in Settings: https://t.me/${this.botUsername ?? 'ClipForgeBot'}`);
      return;
    }

    if (command === '/status') {
      const user = await prisma.user.findUnique({
        where: { telegramUserId: String(sender.id) },
        select: { telegramLinkedAt: true },
      });
      await this.reply(chatId, user ? `Connected to ClipForge${user.telegramLinkedAt ? ` since ${user.telegramLinkedAt.toISOString().slice(0, 10)}` : ''}.` : 'This Telegram account is not connected to ClipForge. Sign in and start from Settings.');
      return;
    }

    if (command === '/disconnect') {
      await this.disconnectFromBot(String(sender.id), chatId);
      return;
    }

    await this.reply(chatId, 'I did not recognize that command. Send /help for the list of commands.');
  }

  private async completeConnection(token: string, telegramUserId: string, chatId: string, username: string | null): Promise<void> {
    const tokenHash = hashToken(token);
    const now = new Date();
    try {
      const userId = await prisma.$transaction(async (tx) => {
        const connection = await tx.telegramConnectionToken.findUnique({ where: { tokenHash } });
        if (!connection || connection.consumedAt || connection.expiresAt <= now) {
          throw new BadRequestException('invalid or expired connection token');
        }
        const consumed = await tx.telegramConnectionToken.updateMany({
          where: { id: connection.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw new BadRequestException('connection token already used');

        const user = await tx.user.findUnique({ where: { id: connection.userId }, select: { status: true, deletedAt: true, telegramUserId: true } });
        if (!user || user.deletedAt || user.status !== 'ACTIVE') throw new BadRequestException('ClipForge account is not active');
        if (user.telegramUserId && user.telegramUserId !== telegramUserId) {
          throw new BadRequestException('this ClipForge account already has a different Telegram connection');
        }

        const accountAlreadyConnected = await tx.user.findFirst({
          where: {
            OR: [{ telegramUserId }, { telegramLoginId: telegramUserId }],
            NOT: { id: connection.userId },
          },
          select: { id: true },
        });
        if (accountAlreadyConnected) throw new BadRequestException('this Telegram account is already linked to another ClipForge account');

        await tx.user.update({
          where: { id: connection.userId },
          data: { telegramUserId, telegramUsername: username, telegramChatId: chatId, telegramLinkedAt: now },
        });
        return connection.userId;
      }, { isolationLevel: 'Serializable' });

      await appendAuditLog({
        userId,
        action: 'AUTH_TELEGRAM_LINKED',
        summary: `Telegram bot account connected (chat ending ${chatId.slice(-4)})`,
      }).catch(() => undefined);
      await this.reply(chatId, 'Telegram is now connected to your ClipForge account. Use /status to check the connection or /disconnect to remove it.');
    } catch {
      // The token, Telegram ID and database error are deliberately never echoed into chat.
      await this.reply(chatId, 'That connection link is invalid, expired, already used, or belongs to another account. Start a fresh connection from ClipForge Settings.');
    }
  }

  private async disconnectFromBot(telegramUserId: string, chatId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { telegramUserId }, select: { id: true, otpMode: true } });
    if (!user) {
      await this.reply(chatId, 'This Telegram account is not connected to ClipForge.');
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          telegramUserId: null,
          telegramUsername: null,
          telegramChatId: null,
          telegramLinkedAt: null,
          ...(user.otpMode === 'TELEGRAM' ? { otpMode: 'OFF' } : user.otpMode === 'DUAL' ? { otpMode: 'EMAIL' } : {}),
        },
      });
      await tx.telegramConnectionToken.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }, { isolationLevel: 'Serializable' });
    await appendAuditLog({ userId: user.id, action: 'AUTH_TELEGRAM_DISCONNECTED', summary: 'Telegram bot account disconnected by the account owner' }).catch(() => undefined);
    await this.reply(chatId, 'Telegram has been disconnected from your ClipForge account.');
  }

  private async reply(chatId: string, text: string): Promise<void> {
    const client = this.notifications.telegramClient();
    if (!client) return;
    await client.sendMessage(chatId, text);
  }
}
