import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, InternalServerErrorException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { appendAuditLog, timingSafeEqual } from '@clipforge/database';
import { z } from 'zod';
import { botProvidersResponseSchema, botLoginStatusResponseSchema } from '@clipforge/validation';
import { CurrentContext, Public, SkipCsrf } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { env } from '../common/env';
import { describeBotSession } from './bot-session-description';
import { SessionService } from './session.service';
import { TelegramAccountService } from './telegram-account.service';
import { botConfiguration, TelegramBotLoginService } from './telegram-bot-login.service';

/** Response failures are server errors, not client Zod input-validation failures. */
function authResponse<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new InternalServerErrorException({ code: 'AUTH_CONTRACT_ERROR', message: 'Authentication response validation failed. Report the request ID to the operator.' });
  return result.data;
}

const BROWSER_COOKIE = 'cf_bot_login';
const cookie = () => ({ httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/api/auth/telegram' });
export const botUpdateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z.object({
    text: z.string().max(4096).optional(),
    from: z.object({ id: z.number().int().positive().safe(), is_bot: z.boolean().optional(), username: z.string().max(32).optional(), first_name: z.string().max(128).optional() }).optional(),
    chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  }).optional(),
});

@Controller('api/auth')
export class BotAuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TelegramBotLoginService) private readonly login: TelegramBotLoginService,
    @Inject(TelegramAccountService) private readonly accounts: TelegramAccountService,
  ) {}

  @Get('providers') @Public() @SkipCsrf()
  providers() { const config = botConfiguration(); return authResponse(botProvidersResponseSchema.safeParse({ contractVersion: 'telegram-bot-v1', password: false, selfRegistrationEnabled: false, telegram: { enabled: config.configured, ...config }, providers: ['TELEGRAM_BOT'] })); }

  @Get('csrf') @Public() @SkipCsrf()
  csrf(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { token, cookieValue } = this.sessions.issueAnonymousCsrf();
    res.cookie('cf_csrf', cookieValue, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60_000 });
    return { csrfToken: token };
  }

  @Post('telegram/challenge') @Public()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'bot-login-create' })
  async challenge(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.login.create(req.cookies?.[BROWSER_COOKIE]);
    res.cookie(BROWSER_COOKIE, result.browser, { ...cookie(), maxAge: env.TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS * 1000 });
    return { deepLink: result.deepLink, expiresAt: result.expiresAt };
  }

  @Get('telegram/status') @Public()
  @RateLimit({ limit: 180, windowSeconds: 300, scope: 'bot-login-status' })
  async status(@Req() req: Request) { return authResponse(botLoginStatusResponseSchema.safeParse(await this.login.status(req.cookies?.[BROWSER_COOKIE]))); }

  @Post('telegram/complete') @Public() @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'bot-login-complete' })
  async complete(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.login.complete(req.cookies?.[BROWSER_COOKIE], req);
    // Revoke an old session only after successful authentication; never trust browser identity.
    const old = (req as Request & { context?: RequestContext }).context;
    if (old) await this.sessions.revoke(old.sessionId);
    res.cookie(SessionService.COOKIE_NAME, result.rawToken, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SessionService.TTL_MS });
    res.clearCookie(BROWSER_COOKIE, cookie());
    return { authenticated: true, csrfToken: result.csrfToken };
  }

  @Post('telegram/webhook') @Public() @SkipCsrf() @HttpCode(200)
  @RateLimit({ limit: 1000, windowSeconds: 60, scope: 'bot-webhook' })
  async webhook(@Req() req: Request, @Body() body: unknown) {
    const secret = req.get('x-telegram-bot-api-secret-token');
    if (!env.TELEGRAM_WEBHOOK_SECRET || !secret || !timingSafeEqual(env.TELEGRAM_WEBHOOK_SECRET, secret)) throw new ForbiddenException({ code: 'WEBHOOK_FORBIDDEN', message: 'Invalid webhook authentication.' });
    const update = botUpdateSchema.parse(body);
    const message = update.message;
    if (message?.from && !message.from.is_bot && message.chat.type === 'private' && message.from.id === message.chat.id) {
      const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+login_([A-Za-z0-9_-]{43})$/.exec(message.text?.trim() ?? '');
      if (match) {
        const approved = await this.login.approve(update.update_id, match[1], message.from);
        if (approved) await this.accounts.loginNotice(String(message.chat.id));
      } 
      else await this.accounts.handleUpdate(update);
    }
    return { ok: true };
  }

  @Get('session') @Public()
  async session(@CurrentContext() ctx?: RequestContext) {
    if (!ctx) return { authenticated: false, selfRegistrationEnabled: false };
    const description = await describeBotSession(ctx);
    if (ctx.developmentBypass) return { authenticated: false, developmentAccess: true, selfRegistrationEnabled: false, ...description };
    return { authenticated: true, selfRegistrationEnabled: false, csrfToken: this.sessions.reissueCsrf(ctx.sessionId), ...description };
  }

  @Post('logout') @HttpCode(200)
  async logout(@CurrentContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(ctx.sessionId);
    await appendAuditLog({ userId: ctx.userId, action: 'AUTH_SESSION_REVOKED', summary: 'Signed out of ClipForge' });
    res.clearCookie(SessionService.COOKIE_NAME, { path: '/' });
    return { loggedOut: true };
  }
}
