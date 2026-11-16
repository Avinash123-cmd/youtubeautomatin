import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { authHttpMetadata } from '../../apps/api/src/common/auth-http.middleware';
import { SessionAuthGuard } from '../../apps/api/src/common/guards/session-auth.guard';
import cookieParser from 'cookie-parser';
import { corsOptions } from '../../apps/api/src/common/origin-policy';
import { CsrfGuard } from '../../apps/api/src/common/guards/csrf.guard';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
import { NestFactory, Reflector } from '@nestjs/core';
import request from 'supertest';
import { AuthController } from '../../apps/api/src/auth/auth.controller';
import { SessionService } from '../../apps/api/src/auth/session.service';
import { AuthService } from '../../apps/api/src/auth/auth.service';
import { FirebaseService } from '../../apps/api/src/auth/firebase.service';
import { TelegramOidcService } from '../../apps/api/src/auth/telegram-oidc.service';
import { TelegramAccountService } from '../../apps/api/src/auth/telegram-account.service';
vi.mock('@clipforge/database', async original => ({ ...await original<typeof import('@clipforge/database')>(), prisma: {} }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { SESSION_SECRET: 'test-only-secret-with-at-least-32-characters', NODE_ENV: 'test', LOG_LEVEL: 'silent', ALLOW_SELF_REGISTRATION: false, FIREBASE_ALLOW_NEW_USERS: false } }));
@Module({
  controllers: [AuthController],
  providers: [SessionService, FirebaseService, TelegramOidcService, { provide: TelegramAccountService, useValue: new TelegramAccountService({} as never) }, { provide: AuthService, useValue: {} }],
})
class TestModule {}
describe('Nest constructs the actual auth controller (no constructor metadata)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await NestFactory.create(TestModule, { logger: false }); app.getHttpAdapter().getInstance().disable('etag'); app.use(authHttpMetadata); app.use(cookieParser()); app.enableCors(corsOptions('http://localhost:3000')); app.useGlobalFilters(new AllExceptionsFilter()); app.useGlobalGuards(new SessionAuthGuard(new Reflector(), new SessionService()), new CsrfGuard(new Reflector(), new SessionService())); await app.init(); if (process.env.CSRF_PROXY_TEST) await app.listen(4000, '0.0.0.0'); });
  afterAll(async () => { await app?.close(); });
  it('injects SessionService and returns a real signed cookie without persistence', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const cookie = decodeURIComponent(res.headers['set-cookie'][0].split(';')[0].slice('cf_csrf='.length));
    expect(new SessionService().verifyAnonymousCsrf(cookie, res.body.csrfToken)).toBe(true);
  });
  it('discovers absent OAuth providers honestly with real provider services', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/providers').expect(200);
    expect(res.body).toMatchObject({ password: true, firebase: { enabled: false, config: null }, telegram: { enabled: false, botUsername: null } });
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('does not return a conditional session response and correlates guard errors', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/session').set('If-None-Match', '*').expect(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    const logout = await request(app.getHttpServer()).post('/api/auth/logout').set('x-request-id', 'logout-test').expect(401);
    expect(logout.body.error.requestId).toBe('logout-test');
    expect(logout.headers['x-request-id']).toBe('logout-test');
  });
  it('protects bootstrap before validating its request', async () => {
    await request(app.getHttpServer()).post('/api/auth/bootstrap').send({}).expect(403);
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const bad = await request(app.getHttpServer()).post('/api/auth/bootstrap').set('Cookie', res.headers['set-cookie'][0].split(';')[0]).set('x-csrf-token', res.body.csrfToken).send({}).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
  it('accepts the configured origin and rejects an untrusted origin', async () => {
    await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'http://localhost:3000').expect(200);
    const bad = await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'https://evil.test').expect(403);
    expect(bad.body.error.code).toBe('ORIGIN_FORBIDDEN');
  });
  it('rejects missing/invalid tokens and lets a valid token reach login body validation', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    await request(app.getHttpServer()).post('/api/auth/login').send({}).expect(403);
    await request(app.getHttpServer()).post('/api/auth/login').set('Cookie', cookie).set('x-csrf-token', 'wrong').send({}).expect(403);
    const valid = await request(app.getHttpServer()).post('/api/auth/login').set('Cookie', cookie).set('x-csrf-token', res.body.csrfToken).send({}).expect(400);
    expect(valid.body.error.code).toBe('VALIDATION_FAILED');
  });
  it.runIf(Boolean(process.env.CSRF_PROXY_TEST))('passes cookies, origin and CSRF through the actual Next rewrite', async () => {
    const res = await fetch('http://localhost:3000/api/auth/csrf', { headers: { Origin: 'http://localhost:3000' } });
    expect(res.status).toBe(200);
    const { csrfToken } = await res.json() as { csrfToken: string };
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect(new SessionService().verifyAnonymousCsrf(decodeURIComponent(cookie.slice(8)), csrfToken)).toBe(true);
    const post = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(400);
    expect((await post.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect((await fetch('http://localhost:3000/api/auth/csrf', { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    const providers = await fetch('http://localhost:3000/api/auth/providers');
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({ password: true, firebase: { enabled: false }, telegram: { enabled: false } });
    const session = await fetch('http://localhost:3000/api/auth/session', { headers: { 'If-None-Match': '*' } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: false });
    const headers = { Cookie: cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
    const bootstrap = await fetch('http://localhost:3000/api/auth/bootstrap', { method: 'POST', headers, body: '{}' });
    expect(bootstrap.status).toBe(400);
    const logout = await fetch('http://localhost:3000/api/auth/logout', { method: 'POST', headers });
    expect(logout.status).toBe(401);
    expect((await logout.json() as { error: { requestId: string } }).error.requestId).toBeTruthy();

  });

});
