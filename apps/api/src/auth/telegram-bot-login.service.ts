import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@clipforge/database';
import type { Request } from 'express';
import { env } from '../common/env';
import { SessionService } from './session.service';

export const browserTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function loginHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function botConfiguration() {
  const missing = (['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'] as const).filter(key => !env[key]);
  return { configured: missing.length === 0, missing };
}
export interface BotSender { id: number; username?: string; first_name?: string; is_bot?: boolean }

@Injectable()
export class TelegramBotLoginService {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async create(previousVerifier?: string) {
    const config = botConfiguration();
    if (!config.configured) throw new ServiceUnavailableException({ code: 'TELEGRAM_BOT_NOT_CONFIGURED', message: `Configure ${config.missing.join(', ')} before signing in.` });
    const token = randomBytes(32).toString('base64url');
    const browser = previousVerifier && browserTokenPattern.test(previousVerifier) ? previousVerifier : randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env.TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS * 1000);
    await prisma.$transaction(async tx => {
      // One row per browser verifier; concurrent regeneration rotates the same challenge.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${loginHash(browser)}, 0))`;
      await tx.telegramBotLoginChallenge.upsert({ where: { browserHash: loginHash(browser) }, create: { tokenHash: loginHash(token), browserHash: loginHash(browser), expiresAt }, update: { tokenHash: loginHash(token), expiresAt, approvedAt: null, consumedAt: null, userId: null } });
    });
    return { browser, deepLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`, expiresAt: expiresAt.toISOString() };
  }

  async status(verifier?: string) {
    if (!verifier || !browserTokenPattern.test(verifier)) return { state: 'IDLE' as const };
    const challenge = await prisma.telegramBotLoginChallenge.findUnique({ where: { browserHash: loginHash(verifier) }, include: { user: { select: { displayName: true, telegramUsername: true } } } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) return { state: 'EXPIRED' as const };
    return { state: challenge.approvedAt ? 'VERIFYING' as const : 'WAITING_FOR_TELEGRAM' as const, expiresAt: challenge.expiresAt.toISOString(), identity: challenge.user ? { displayName: challenge.user.displayName, username: challenge.user.telegramUsername } : null };
  }

  /** Called ONLY after webhook secret + update schema validation; no identity accepted from browser. */
  async approve(updateId: number, token: string, sender: BotSender) {
    if (!browserTokenPattern.test(token) || sender.is_bot) return false;
    return this.retryTransaction(async tx => {
      const accepted = await tx.telegramBotUpdate.createMany({ data: { id: BigInt(updateId) }, skipDuplicates: true });
      if (!accepted.count) return false;
      const now = new Date();
      const challenge = await tx.telegramBotLoginChallenge.findUnique({ where: { tokenHash: loginHash(token) } });
      if (!challenge || challenge.approvedAt || challenge.consumedAt || challenge.expiresAt <= now) return false;
      // Match bot IDs only. Legacy OIDC subjects are not assumed to be Bot API sender IDs.
      const telegramUserId = String(sender.id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`telegram-bot:${telegramUserId}`}, 0))`;
      let user = await tx.user.findUnique({ where: { telegramUserId } });
      if (user && (user.deletedAt || user.status !== 'ACTIVE')) return false;
      if (!user) {
        const id = randomUUID();
        const displayName = sender.first_name?.trim().slice(0, 120) || 'Telegram account';
        // Reserved non-deliverable placeholder for the required legacy email column; never used
        // to merge accounts, authenticate, or deliver mail. Keep profile email fields intact.
        user = await tx.user.create({ data: { id, email: `bot-${id}@users.telegram.invalid`, displayName, telegramUserId, telegramChatId: telegramUserId, telegramUsername: sender.username ?? null, telegramLinkedAt: now, passwordHash: null } });
        const workspace = await tx.workspace.create({ data: { name: `${displayName}'s workspace`, slug: `workspace-${id}`, timezone: env.TIMEZONE } });
        await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId: id, role: 'OWNER' } });
      } else {
        user = await tx.user.update({ where: { id: user.id }, data: { telegramChatId: telegramUserId, telegramUsername: sender.username ?? null, telegramLinkedAt: user.telegramLinkedAt ?? now } });
      }
      const approved = await tx.telegramBotLoginChallenge.updateMany({ where: { id: challenge.id, approvedAt: null, consumedAt: null, expiresAt: { gt: now } }, data: { userId: user.id, approvedAt: now } });
      if (approved.count) await tx.auditLog.create({ data: { userId: user.id, action: 'AUTH_TELEGRAM_LINKED', summary: 'Telegram bot login approved' } });
      return approved.count === 1;
    });
  }

  async complete(verifier: string | undefined, request: Request) {
    if (!verifier || !browserTokenPattern.test(verifier)) throw this.rejected();
    return this.retryTransaction(async tx => {
      const challenge = await tx.telegramBotLoginChallenge.findUnique({ where: { browserHash: loginHash(verifier) } });
      const now = new Date();
      if (!challenge?.userId || !challenge.approvedAt || challenge.consumedAt || challenge.expiresAt <= now) throw this.rejected();
      const consumed = await tx.telegramBotLoginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, approvedAt: { not: null } }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw this.rejected();
      const user = await tx.user.findUnique({ where: { id: challenge.userId } });
      if (!user || user.deletedAt || user.status !== 'ACTIVE' || !user.telegramUserId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This account cannot sign in.' });
      const session = await this.sessions.issue(user.id, request, tx);
      if (!session) throw new ForbiddenException({ code: 'WORKSPACE_REQUIRED', message: 'No workspace is associated with this account. Contact an administrator.' });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      await tx.loginEvent.create({ data: { userId: user.id, method: 'TELEGRAM', outcome: 'SUCCESS', detail: 'Telegram Bot private-chat verification', ipAddress: request.ip, userAgent: request.get('user-agent')?.slice(0, 400) } });
      return session;
    });
  }

  private rejected() { return new BadRequestException({ code: 'TELEGRAM_CHALLENGE_REJECTED', message: 'This login has not been approved, has expired, or was already used. Start again.' }); }
  private async retryTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await prisma.$transaction(fn, { isolationLevel: 'Serializable' }); }
      catch (error) { if (attempt < 2 && ['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')) continue; throw error; }
    }
  }
}
