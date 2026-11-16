import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { BotAuthController } from '../../apps/api/src/auth/bot-auth.controller';
import { BotSecurityController } from '../../apps/api/src/auth/bot-security.controller';
import { SessionService } from '../../apps/api/src/auth/session.service';
import { TelegramBotLoginService } from '../../apps/api/src/auth/telegram-bot-login.service';
import { TelegramAccountService } from '../../apps/api/src/auth/telegram-account.service';
import { CsrfGuard } from '../../apps/api/src/common/guards/csrf.guard';
import { SessionAuthGuard } from '../../apps/api/src/common/guards/session-auth.guard';
import { corsOptions } from '../../apps/api/src/common/origin-policy';
import { authHttpMetadata } from '../../apps/api/src/common/auth-http.middleware';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
import { AuthModule } from '../../apps/api/src/auth/auth.module';
const env = vi.hoisted(() => ({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SESSION_SECRET: 'test-only-32-character-session-secret', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret', TELEGRAM_BOT_USERNAME: 'ClipForgeBot', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS: 300 }));
vi.mock('../../apps/api/src/common/env', () => ({ env }));
const approve = vi.fn();
const create = vi.fn().mockResolvedValue({ browser: 'b'.repeat(43), deepLink: `https://t.me/ClipForgeBot?start=login_${'t'.repeat(43)}`, expiresAt: new Date(Date.now() + 300000).toISOString() });
const accounts = { handleUpdate: vi.fn() };
@Module({ controllers: [BotAuthController], providers: [SessionService, { provide: TelegramBotLoginService, useValue: { approve, create } }, { provide: TelegramAccountService, useValue: accounts }] })
class HttpModule {}
let app: INestApplication;
beforeAll(async () => {
  app = await NestFactory.create(HttpModule, { logger: false });
  app.getHttpAdapter().getInstance().disable('etag');
  app.use(authHttpMetadata); app.use(cookieParser()); app.enableCors(corsOptions('http://localhost:3000'));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalGuards(new SessionAuthGuard(new Reflector(), new SessionService()), new CsrfGuard(new Reflector(), new SessionService()));
  await app.init();
  if (process.env.BOT_PROXY_TEST) await app.listen(4000, '0.0.0.0');
});
afterAll(async () => { await app?.close(); });
const update = (overrides = {}) => ({ update_id: 1, message: { text: `/start login_${'a'.repeat(43)}`, from: { id: 12345, is_bot: false }, chat: { id: 12345, type: 'private' }, ...overrides } });
describe('active bot-only HTTP boundary (isolated providers, not live Telegram)', () => {
  it('registers only bot controllers in the production auth module', () => {
    expect(Reflect.getMetadata('controllers', AuthModule)).toEqual([BotAuthController, BotSecurityController]);
  });
  it('reports only Telegram and returns a genuine signed CSRF cookie', async () => {
    const providers = await request(app.getHttpServer()).get('/api/auth/providers').expect(200);
    expect(providers.body).toMatchObject({ password: false, selfRegistrationEnabled: false, providers: ['TELEGRAM_BOT'], telegram: { enabled: true } });
    expect(providers.body.firebase).toBeUndefined();
    const csrf = await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'http://localhost:3000').expect(200);
    const cookie = decodeURIComponent(csrf.headers['set-cookie'][0].split(';')[0].slice(8));
    expect(new SessionService().verifyAnonymousCsrf(cookie, csrf.body.csrfToken)).toBe(true);
    expect(csrf.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(csrf.headers['set-cookie'][0]).toContain('SameSite=Lax');
  });
  it('sets the browser binding only as an HttpOnly cookie on CSRF-protected challenge creation', async () => {
    const csrf = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const result = await request(app.getHttpServer()).post('/api/auth/telegram/challenge').set('Cookie', csrf.headers['set-cookie'][0].split(';')[0]).set('x-csrf-token', csrf.body.csrfToken).send({ telegramUserId: 'untrusted-browser-value' }).expect(201);
    expect(create).toHaveBeenCalledWith(undefined);
    expect(result.body.browser).toBeUndefined();
    expect(result.headers['set-cookie'][0]).toContain('cf_bot_login=');
    expect(result.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(result.headers['set-cookie'][0]).toContain('Path=/api/auth/telegram');
  });
  it('rejects missing config explicitly instead of inventing provider availability', async () => {
    const saved = env.TELEGRAM_BOT_TOKEN; env.TELEGRAM_BOT_TOKEN = '';
    try {
      const result = await request(app.getHttpServer()).get('/api/auth/providers').expect(200);
      expect(result.body.telegram).toMatchObject({ enabled: false, missing: ['TELEGRAM_BOT_TOKEN'] });
    } finally { env.TELEGRAM_BOT_TOKEN = saved; }
  });
  it.each(['login', 'firebase', 'register', 'bootstrap', 'security/reset-password', 'security/recovery-codes/redeem', 'security/otp/step-up/complete'])('does not register retired session entry point %s', async path => {
    const csrf = await request(app.getHttpServer()).get('/api/auth/csrf');
    await request(app.getHttpServer()).post(`/api/auth/${path}`).set('Cookie', csrf.headers['set-cookie'][0].split(';')[0]).set('x-csrf-token', csrf.body.csrfToken).send({}).expect(404);
  });
  it('rejects invalid origins and missing mutation CSRF', async () => {
    await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'https://evil.test').expect(403);
    await request(app.getHttpServer()).post('/api/auth/telegram/challenge').expect(403);
    await request(app.getHttpServer()).post('/api/auth/telegram/complete').expect(403);
  });
  it('authenticates webhook before accepting any browser-provided identity', async () => {
    await request(app.getHttpServer()).post('/api/auth/telegram/webhook').send(update()).expect(403);
    await request(app.getHttpServer()).post('/api/auth/telegram/webhook').set('x-telegram-bot-api-secret-token', 'wrong').send(update()).expect(403);
    expect(approve).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/auth/telegram/webhook').set('x-telegram-bot-api-secret-token', env.TELEGRAM_WEBHOOK_SECRET).send(update()).expect(200);
    expect(approve).toHaveBeenCalledWith(1, 'a'.repeat(43), { id: 12345, is_bot: false });
  });
  it('ignores non-private/mismatched/bot senders and rejects malformed updates', async () => {
    const before = approve.mock.calls.length;
    for (const body of [update({ chat: { id: 12345, type: 'group' } }), update({ from: { id: 22222 } }), update({ from: { id: 12345, is_bot: true } })]) {
      await request(app.getHttpServer()).post('/api/auth/telegram/webhook').set('x-telegram-bot-api-secret-token', env.TELEGRAM_WEBHOOK_SECRET).send(body).expect(200);
    }
    expect(approve).toHaveBeenCalledTimes(before);
    await request(app.getHttpServer()).post('/api/auth/telegram/webhook').set('x-telegram-bot-api-secret-token', env.TELEGRAM_WEBHOOK_SECRET).send({ update_id: -1 }).expect(400);
  });
  it('GET session never creates a session or returns cached 304', async () => {
    const result = await request(app.getHttpServer()).get('/api/auth/session').set('If-None-Match', '*').expect(200);
    expect(result.body.authenticated).toBe(false);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['set-cookie']).toBeUndefined();
  });
  it.runIf(Boolean(process.env.BOT_PROXY_TEST))('uses the actual Next rewrite for discovery, cookies, CSRF and webhook rejection', async () => {
    const providers = await fetch('http://localhost:3000/api/auth/providers');
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({ providers: ['TELEGRAM_BOT'], password: false });
    const csrf = await fetch('http://localhost:3000/api/auth/csrf');
    expect(csrf.status).toBe(200);
    expect(csrf.headers.get('set-cookie')).toContain('HttpOnly');
    const csrfBody = await csrf.json() as { csrfToken: string };
    const challenge = await fetch('http://localhost:3000/api/auth/telegram/challenge', { method: 'POST', headers: { Cookie: csrf.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': csrfBody.csrfToken } });
    expect(challenge.status).toBe(201);
    expect(challenge.headers.get('set-cookie')).toContain('cf_bot_login=');
    expect(challenge.headers.get('set-cookie')).toContain('HttpOnly');

    const session = await fetch('http://localhost:3000/api/auth/session', { headers: { 'If-None-Match': '*' } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: false });
    expect((await fetch('http://localhost:3000/api/auth/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update()) })).status).toBe(403);
  });
});
