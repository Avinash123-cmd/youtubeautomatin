import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Post, Req, Res, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
const db = vi.hoisted(() => ({ workspaceMember: { findFirst: vi.fn() } }));
vi.mock('@clipforge/database', async importOriginal => ({ ...await importOriginal<object>(), prisma: db }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', SESSION_SECRET: 'isolated-dev-bypass-csrf-secret-at-least-32' } }));
import { SessionAuthGuard } from '../../apps/api/src/common/guards/session-auth.guard';
import { CsrfGuard } from '../../apps/api/src/common/guards/csrf.guard';
import { RateLimitGuard } from '../../apps/api/src/common/guards/rate-limit.guard';
import { SessionService } from '../../apps/api/src/auth/session.service';
import { CurrentContext, Public, SkipCsrf } from '../../apps/api/src/common/decorators/auth.decorators';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
import { corsOptions } from '../../apps/api/src/common/origin-policy';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
const sessions = new SessionService();
const budget = { hit: vi.fn(async () => ({ allowed: true, remaining: 10, resetSeconds: 60 })) };
@Controller('api')
class Fixture {
  @Get('auth/csrf') @Public() @SkipCsrf()
  csrf(@Res({ passthrough: true }) res: Response) { const value = sessions.issueAnonymousCsrf(); res.cookie('cf_csrf', value.cookieValue, { httpOnly: true }); return { csrfToken: value.token }; }
  @Get('dashboard/summary') dashboard(@CurrentContext() ctx: RequestContext) { return { workspaceId: ctx.workspaceId, developmentBypass: ctx.developmentBypass }; }
  @Post('jobs') jobs(@Req() _req: Request) { return { accepted: true }; }
  @Post('publishing/jobs') publish() { throw new Error('must never reach publishing'); }
}
@Module({ controllers: [Fixture] }) class FixtureModule {}
let app: INestApplication;
beforeAll(async () => {
  app = await NestFactory.create(FixtureModule, { logger: false }); app.use(cookieParser()); app.enableCors(corsOptions('http://localhost:3000'));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalGuards(new SessionAuthGuard(new Reflector(), sessions), new RateLimitGuard(new Reflector(), budget as never), new CsrfGuard(new Reflector(), sessions));
  await app.init();
});
afterAll(async () => app.close());
beforeEach(() => {
  vi.stubEnv('AUTH_BYPASS', 'true'); vi.stubEnv('NODE_ENV', 'development');
  for (const key of ['VERCEL', 'RENDER', 'NETLIFY']) vi.stubEnv(key, '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/isolated');
  vi.stubEnv('AUTH_BYPASS_USER_ID', '11111111-1111-4111-8111-111111111111'); vi.stubEnv('AUTH_BYPASS_WORKSPACE_ID', '22222222-2222-4222-8222-222222222222');
  db.workspaceMember.findFirst.mockResolvedValue({ userId: 'dev-user', workspaceId: 'dev-workspace', role: 'MEMBER', user: { email: 'test@example.test', displayName: 'Existing developer' }, workspace: { name: 'Sandbox', slug: 'dev-auth-bypass-http', timezone: null } });
});
afterEach(() => vi.unstubAllEnvs());
it('serves repeated dashboard requests without an auth cookie (including refresh)', async () => {
  for (let i = 0; i < 2; i++) { const response = await request(app.getHttpServer()).get('/api/dashboard/summary').expect(200); expect(response.body).toEqual({ workspaceId: 'dev-workspace', developmentBypass: true }); expect(response.headers['set-cookie']).toBeUndefined(); }
});
it('keeps CSRF enforced for processing writes and the rate limiter active', async () => {
  await request(app.getHttpServer()).post('/api/jobs').send({ configuration: { autoPublish: false } }).expect(403);
  const agent = request.agent(app.getHttpServer());
  const csrf = await agent.get('/api/auth/csrf').expect(200);
  await agent.post('/api/jobs').set('x-csrf-token', csrf.body.csrfToken).send({ configuration: { autoPublish: false } }).expect(201);
  expect(budget.hit).toHaveBeenCalled();
});
it('retains origin restrictions and never permits publishing without login', async () => {
  await request(app.getHttpServer()).get('/api/dashboard/summary').set('Origin', 'https://attacker.example').expect(403);
  await request(app.getHttpServer()).post('/api/publishing/jobs').send({}).expect(401);
});
it('rejects the same anonymous dashboard request in production', async () => { vi.stubEnv('NODE_ENV', 'production'); await request(app.getHttpServer()).get('/api/dashboard/summary').expect(401); });
it('restores normal login requirement with AUTH_BYPASS=false', async () => { vi.stubEnv('AUTH_BYPASS', 'false'); await request(app.getHttpServer()).get('/api/dashboard/summary').expect(401); });
