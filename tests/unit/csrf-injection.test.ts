import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
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
vi.mock('../../apps/api/src/common/env', () => ({ env: { SESSION_SECRET: 'test-only-secret-with-at-least-32-characters', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
@Module({
  controllers: [AuthController],
  providers: [SessionService, ...[AuthService, FirebaseService, TelegramOidcService, TelegramAccountService].map(provide => ({ provide, useValue: {} }))],
})
class TestModule {}
describe('Nest constructs the actual auth controller (no constructor metadata)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await NestFactory.create(TestModule, { logger: false }); app.use(cookieParser()); app.enableCors(corsOptions('http://localhost:3000')); app.useGlobalFilters(new AllExceptionsFilter()); app.useGlobalGuards(new CsrfGuard(new Reflector(), new SessionService())); await app.init(); if (process.env.CSRF_PROXY_TEST) await app.listen(4000, '0.0.0.0'); });
  afterAll(async () => { await app?.close(); });
  it('injects SessionService and returns a real signed cookie without persistence', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const cookie = decodeURIComponent(res.headers['set-cookie'][0].split(';')[0].slice('cf_csrf='.length));
    expect(new SessionService().verifyAnonymousCsrf(cookie, res.body.csrfToken)).toBe(true);
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
  });

});
