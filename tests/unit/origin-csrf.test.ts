import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Post, Req, Res, UseGuards, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Request, Response } from 'express';
import { corsOptions, createOriginPolicy } from '../../apps/api/src/common/origin-policy';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
import { CsrfGuard } from '../../apps/api/src/common/guards/csrf.guard';
import { AuthController } from '../../apps/api/src/auth/auth.controller';
import { SKIP_CSRF } from '../../apps/api/src/common/decorators/auth.decorators';
import { SessionService } from '../../apps/api/src/auth/session.service';

vi.mock('../../apps/api/src/common/env', () => ({ env: { SESSION_SECRET: 'test-only-secret-with-at-least-32-characters', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
const sessions = new SessionService();
const received: Array<{ origin?: string; host?: string }> = [];
@Controller('api/auth')
class FixtureController {
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    received.push({ origin: req.get('origin'), host: req.get('host') });
    // Invoke the production controller implementation, not a duplicate token endpoint.
    return AuthController.prototype.csrf.call({ sessions } as unknown as AuthController, res);
  }
  @Post('probe')
  @UseGuards(new CsrfGuard(new Reflector(), sessions))
  mutate() { return { ok: true }; }
}
@Module({ controllers: [FixtureController] })
class FixtureModule {}

describe('origin policy', () => {
  it('normalizes configured origins, but never aliases loopback addresses', () => {
    const allowed = createOriginPolicy('http://localhost:3000/');
    expect(allowed('http://localhost:3000')).toBe(true);
    for (const origin of ['http://127.0.0.1:3000', 'null', 'https://evil.test', 'http://localhost:3000/path', 'http://localhost:3000.evil.test']) expect(allowed(origin)).toBe(false);
  });
  it('bounds explicit production wildcards to HTTPS subdomains', () => {
    const allowed = createOriginPolicy('https://*.preview.example.com');
    expect(allowed('https://a.preview.example.com')).toBe(true);
    for (const origin of ['https://preview.example.com', 'http://a.preview.example.com', 'https://a.preview.example.com.evil.test']) expect(allowed(origin)).toBe(false);
    expect(() => createOriginPolicy('*')).toThrow();
  });
});

describe('real Nest HTTP origin and anonymous CSRF boundary (isolated from persistence)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await NestFactory.create(FixtureModule, { logger: false });
    app.use(cookieParser());
    app.enableCors(corsOptions('http://localhost:3000'));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  it('returns 200 and a verifiable CSRF token, preserving Origin independently of Host', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'http://localhost:3000').set('Host', '127.0.0.1:4000').expect(200);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    expect(received.at(-1)).toEqual({ origin: 'http://localhost:3000', host: '127.0.0.1:4000' });
    await request(app.getHttpServer()).post('/api/auth/probe').set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('x-csrf-token', res.body.csrfToken).expect(201);
    await request(app.getHttpServer()).post('/api/auth/probe').set('Cookie', cookie).set('x-csrf-token', 'invalid').expect(403);
  });
  it('rejects bad origins as structured 403, not 500, even for safe GET', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').set('Origin', 'https://evil.test').expect(403);
    expect(res.body.error.code).toBe('ORIGIN_FORBIDDEN');
  });
  it('allows originless safe GET but never an unsafe request without CSRF', async () => {
    await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const res = await request(app.getHttpServer()).post('/api/auth/probe').expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });
});

 describe('public login routes do not exempt CSRF', () => {
  for (const method of ['login', 'firebaseLogin', 'bootstrap', 'register'] as const) {
    it(`${method} uses the global CSRF guard`, () => {
      expect(Reflect.getMetadata(SKIP_CSRF, AuthController.prototype[method])).not.toBe(true);
    });
  }
});
