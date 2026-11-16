import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { appendAuditLog, prisma } from '@clipforge/database';
import { z } from 'zod';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import type { Request } from 'express';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { TelegramAccountService } from './telegram-account.service';

@Controller('api/auth/security')
export class BotSecurityController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(TelegramAccountService) private readonly accounts: TelegramAccountService, @Inject(OtpService) private readonly otp: OtpService) {}

  @Get('overview')
  async overview(@CurrentContext() ctx: RequestContext) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { displayName: true, telegramUserId: true, telegramUsername: true, telegramLinkedAt: true, lastLoginAt: true } });
    const [sessions, history, events] = await Promise.all([
      prisma.session.findMany({ where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.loginEvent.findMany({ where: { userId: ctx.userId }, select: { id: true, method: true, outcome: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.auditLog.findMany({ where: { userId: ctx.userId }, select: { id: true, action: true, summary: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return { telegram: { connected: Boolean(user.telegramUserId && user.telegramLinkedAt), displayName: user.displayName, username: user.telegramUsername, linkedAt: user.telegramLinkedAt }, lastLoginAt: user.lastLoginAt, sessions: sessions.map(row => ({ ...row, current: row.id === ctx.sessionId })), history, events };
  }

  @Post('telegram/link/start')
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'bot-link' })
  link(@CurrentContext() ctx: RequestContext) { return this.accounts.startConnection(ctx.userId); }

  @Post('telegram/connect')
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'bot-link' })
  connect(@CurrentContext() ctx: RequestContext) { return this.accounts.startConnection(ctx.userId); }

  @Post('telegram/link/complete')
  complete() { throw new ConflictException({ code: 'TELEGRAM_BOT_LINK_REQUIRED', message: 'Complete linking by pressing Start in the bot. Browser-supplied identity is never accepted.' }); }

  @Post('telegram/unlink')
  unlink() { throw new ConflictException({ code: 'ONLY_IDENTITY_REQUIRED', message: 'Telegram is the only sign-in identity and cannot be disconnected. Contact the operator for a verified account migration.' }); }

  /** Optional Telegram-only step-up: this code can revoke sessions, never authenticate. */
  @Post('otp/request')
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'telegram-action-otp', byIp: true })
  requestOtp(@CurrentContext() ctx: RequestContext, @Req() req: Request) { return this.sendOtp(ctx, req); }

  @Post('otp/resend')
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'telegram-action-otp', byIp: true })
  resendOtp(@CurrentContext() ctx: RequestContext, @Req() req: Request) { return this.sendOtp(ctx, req); }

  private async sendOtp(ctx: RequestContext, req: Request) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const delivery = await this.otp.issue({ userId: user.id, email: user.email, telegramChatId: user.telegramChatId, channel: 'TELEGRAM', purpose: 'SESSION_REVOCATION', ipAddress: req.ip, userAgent: req.get('user-agent') });
    if (!delivery.delivered) throw new ServiceUnavailableException({ code: 'TELEGRAM_DELIVERY_FAILED', message: 'Telegram did not accept the verification message. Check the bot connection and retry.' });
    await appendAuditLog({ userId: ctx.userId, action: 'AUTH_OTP_CHALLENGE', summary: 'Telegram verification delivered for session revocation' });
    return { challengeId: delivery.challengeId, delivered: true, action: 'REVOKE_ALL_SESSIONS' };
  }

  @Post('otp/verify')
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'telegram-action-verify', byIp: true })
  async verifyOtp(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).parse(body);
    const challenge = await prisma.otpChallenge.findFirst({ where: { id: input.challengeId, userId: ctx.userId, purpose: 'SESSION_REVOCATION', channel: 'TELEGRAM' } });
    if (!challenge || !(await this.otp.verify(input.challengeId, input.code)).ok) throw new BadRequestException({ code: 'OTP_REJECTED', message: 'Invalid, expired or already used verification code.' });
    await this.sessions.revokeAllForUser(ctx.userId);
    await appendAuditLog({ userId: ctx.userId, action: 'AUTH_OTP_VERIFIED', summary: 'Telegram verification consumed; all sessions revoked' });
    return { verified: true, sessionsRevoked: true };
  }

  @Delete('sessions/:id')
  async revoke(@CurrentContext() ctx: RequestContext, @Param('id') id: string) {
    z.string().uuid().parse(id);
    const row = await prisma.session.findFirst({ where: { id, userId: ctx.userId } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found.' });
    await this.sessions.revoke(row.id);
    await appendAuditLog({ userId: ctx.userId, action: 'AUTH_SESSION_REVOKED', summary: 'A device session was revoked' });
    return { revoked: true };
  }

  @Post('sessions/revoke-all')
  async revokeAll(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const { keepCurrent } = z.object({ keepCurrent: z.boolean().default(false) }).parse(body ?? {});
    const result = await prisma.session.updateMany({ where: { userId: ctx.userId, revokedAt: null, ...(keepCurrent ? { id: { not: ctx.sessionId } } : {}) }, data: { revokedAt: new Date() } });
    await appendAuditLog({ userId: ctx.userId, action: 'AUTH_SESSION_REVOKED', summary: 'Session revocation requested from account security' });
    return { revoked: result.count };
  }
}
