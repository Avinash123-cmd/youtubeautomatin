import { Body, Controller, ForbiddenException, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { bootstrapSchema, firebaseLoginSchema, loginSchema, registerSchema } from '@clipforge/validation';
import { timingSafeEqual } from '@clipforge/database';
import { CurrentContext, Public, SkipCsrf } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { env } from '../common/env';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { SessionService } from './session.service';
import { TelegramOidcService } from './telegram-oidc.service';
import { TelegramAccountService, type TelegramBotUpdate } from './telegram-account.service';

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    text: z.string().max(4096).optional(),
    from: z.object({
      id: z.number().int().positive(),
      username: z.string().max(32).optional(),
      first_name: z.string().max(128).optional(),
    }).passthrough().optional(),
    chat: z.object({ id: z.number().int(), type: z.string().max(32) }).passthrough(),
  }).passthrough().optional(),
}).passthrough();

const TELEGRAM_OIDC_STATE_COOKIE = 'cf_telegram_oidc_state';
const TELEGRAM_OIDC_STATE_TTL_MS = 10 * 60_000;

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly firebase: FirebaseService,
    private readonly telegramOidc: TelegramOidcService,
    private readonly telegramAccount: TelegramAccountService,
  ) {}

  private setSessionCookies(res: Response, rawToken: string): void {
    res.cookie(SessionService.COOKIE_NAME, rawToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.TTL_MS,
    });
  }

  @Get('csrf')
  @Public()
  @SkipCsrf()
  @ApiOperation({ summary: 'Obtain an anonymous CSRF token (signed double-submit cookie)' })
  csrf(@Res({ passthrough: true }) res: Response) {
    const { token, cookieValue } = this.sessions.issueAnonymousCsrf();
    res.cookie('cf_csrf', cookieValue, {
      httpOnly: false,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60_000,
    });
    return { csrfToken: token };
  }

  @Get('providers')
  @Public()
  @SkipCsrf()
  @ApiOperation({ summary: 'Which sign-in methods this deployment offers (drives the login screen)' })
  providers() {
    return {
      password: true,
      selfRegistrationEnabled: env.ALLOW_SELF_REGISTRATION,
      firebase: {
        // `enabled` means "the button will actually complete a sign-in", not "a project id exists".
        enabled: this.firebase.fullyConfigured,
        verifyConfigured: this.firebase.configured,
        webConfigured: this.firebase.webConfigured,
        // Public by design: the same values ship in every Firebase web app's JS bundle.
        config: this.firebase.webConfig(),
        allowNewUsers: env.FIREBASE_ALLOW_NEW_USERS,
        error: this.firebase.missing,
      },
      telegram: {
        enabled: this.telegramOidc.configured,
        botUsername: this.telegramAccount.botUsername,
      },
    };
  }

  @Get('telegram')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 20, windowSeconds: 300, scope: 'auth-telegram-start' })
  @ApiOperation({ summary: 'Start Telegram OpenID Connect Authorization Code flow with PKCE' })
  async startTelegramLogin(@Res() res: Response) {
    const { url, state } = await this.telegramOidc.authorizationUrl();
    res.cookie(TELEGRAM_OIDC_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/telegram/callback',
      maxAge: TELEGRAM_OIDC_STATE_TTL_MS,
    });
    res.redirect(302, url);
  }

  @Get('telegram/callback')
  @Public()
  @SkipCsrf()
  @ApiOperation({ summary: 'Validate Telegram OIDC callback and create a normal ClipForge session' })
  async telegramLoginCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') providerError: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (providerError || !code || !state) {
      const browserState = req.cookies?.[TELEGRAM_OIDC_STATE_COOKIE] as string | undefined;
      if (!state || !browserState || !timingSafeEqual(state, browserState)) {
        return res.redirect(303, new URL('/login?authError=telegram', env.APP_URL).toString());
      }
      await this.telegramOidc.discardTransaction(state);
      res.clearCookie(TELEGRAM_OIDC_STATE_COOKIE, { path: '/api/auth/telegram/callback' });
      return res.redirect(303, new URL('/login?authError=telegram', env.APP_URL).toString());
    }
    const browserState = req.cookies?.[TELEGRAM_OIDC_STATE_COOKIE] as string | undefined;
    if (!browserState || !timingSafeEqual(state, browserState)) {
      return res.redirect(303, new URL('/login?authError=telegram', env.APP_URL).toString());
    }
    try {
      const identity = await this.telegramOidc.completeLogin(code, state);
      const result = await this.auth.loginWithTelegram(identity, req);
      res.clearCookie(TELEGRAM_OIDC_STATE_COOKIE, { path: '/api/auth/telegram/callback' });
      this.setSessionCookies(res, result.rawToken);
      return res.redirect(303, new URL('/', env.APP_URL).toString());
    } catch {
      // The provider's response, code, token and internal failure detail stay out of the URL.
      await this.telegramOidc.discardTransaction(state);
      res.clearCookie(TELEGRAM_OIDC_STATE_COOKIE, { path: '/api/auth/telegram/callback' });
      return res.redirect(303, new URL('/login?authError=telegram', env.APP_URL).toString());
    }
  }

  @Post('telegram/webhook')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 600, windowSeconds: 60, scope: 'telegram-bot-webhook' })
  @ApiOperation({ summary: 'Receive Telegram Bot API updates authenticated by its webhook secret header' })
  async telegramBotWebhook(@Body() body: unknown, @Req() req: Request) {
    const suppliedSecret = req.get('x-telegram-bot-api-secret-token') ?? '';
    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
    if (!expectedSecret || !timingSafeEqual(expectedSecret, suppliedSecret)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Invalid Telegram webhook secret.' });
    }
    const update = telegramUpdateSchema.parse(body) as TelegramBotUpdate;
    await this.telegramAccount.handleUpdate(update);
    return { ok: true };
  }

  @Post('firebase')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'auth-firebase' })
  @ApiOperation({ summary: 'Exchange a Firebase ID token for a ClipForge session (Google sign-in)' })
  async firebaseLogin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { idToken } = firebaseLoginSchema.parse(body);
    const result = await this.auth.loginWithFirebase(idToken, req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('bootstrap')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'auth-bootstrap' })
  @ApiOperation({ summary: 'One-time administrator bootstrap (requires ADMIN_BOOTSTRAP_TOKEN; refuses once a user exists)' })
  async bootstrap(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.bootstrap(bootstrapSchema.parse(body), req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('register')
  @Public()
  @RateLimit({ limit: 5, windowSeconds: 300, scope: 'auth-register' })
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!env.ALLOW_SELF_REGISTRATION) {
      // Explicitly closed by default: an operator must opt in with ALLOW_SELF_REGISTRATION=true.
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Self-service registration is disabled on this deployment. Ask an administrator for an account.',
      });
    }
    const result = await this.auth.register(registerSchema.parse(body), req);
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('login')
  @Public()
  @SkipCsrf()
  @RateLimit({ limit: 10, windowSeconds: 300, scope: 'auth-login' })
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(loginSchema.parse(body), req);
    // Accounts with a second-factor policy get challenges back and NO cookie: the session does not
    // exist yet. `POST /api/auth/security/otp/step-up/complete` sets the cookie on success.
    if ('otpRequired' in result) return result;
    this.setSessionCookies(res, result.rawToken);
    return { csrfToken: result.csrfToken, userId: result.userId, workspaceId: result.workspaceId };
  }

  @Post('logout')
  async logout(@CurrentContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(ctx.sessionId);
    res.clearCookie(SessionService.COOKIE_NAME, { path: '/' });
    return { loggedOut: true };
  }

  @Get('session')
  @Public()
  @ApiOperation({ summary: 'Current session, workspace, configuration readiness and integration status' })
  async session(@Req() req: Request) {
    const raw = req.cookies?.[SessionService.COOKIE_NAME] as string | undefined;
    // The login screen needs this before it can render a "create account" option.
    if (!raw) return { authenticated: false, selfRegistrationEnabled: env.ALLOW_SELF_REGISTRATION };
    const session = await this.sessions.validate(raw, req);
    if (!session) return { authenticated: false, selfRegistrationEnabled: env.ALLOW_SELF_REGISTRATION };
    const description = await this.auth.describeSession({ userId: session.userId, workspaceId: session.workspaceId });
    const csrf = this.sessions.reissueCsrf(session.sessionId);
    return { authenticated: true, ...description, csrfToken: csrf };
  }
}
