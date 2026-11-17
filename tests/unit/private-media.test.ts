import 'reflect-metadata';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
const db = vi.hoisted(() => ({ sourceVideo: { findFirst: vi.fn() }, clipVariant: { findFirst: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db, ConfigurationRequiredError: class extends Error {} }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
import { MediaController } from '../../apps/api/src/media/media.controller';
import { StorageService } from '../../apps/api/src/storage/storage.service';
import { SessionAuthGuard } from '../../apps/api/src/common/guards/session-auth.guard';
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
const bytes = Buffer.from('private-video-bytes');
const storage = { driver: 's3', statSize: vi.fn(async () => bytes.length), getStream: vi.fn(async () => ({ stream: Readable.from([bytes]) })), getStreamRange: vi.fn(async (_key: string, start: number, end: number) => ({ stream: Readable.from([bytes.subarray(start, end + 1)]), contentLength: end - start + 1 })) };
Reflect.defineMetadata('design:paramtypes', [StorageService], MediaController);
@Module({ controllers: [MediaController], providers: [{ provide: StorageService, useValue: storage }] })
class MediaTestModule {}
let app: INestApplication;
beforeAll(async () => {
  app = await NestFactory.create(MediaTestModule, { logger: false });
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalGuards(new SessionAuthGuard(new Reflector(), { validate: async () => ({ workspaceId: 'workspace-a', role: 'MEMBER' }) } as never));
  await app.init();
  db.sourceVideo.findFirst.mockImplementation(async ({ where }) => where.id === 'owned' && where.workspaceId === 'workspace-a' ? { storageKey: 'private/workspace-a/video.mp4' } : null);
});
afterAll(async () => { await app.close(); });
it('does not expose private storage to anonymous users', async () => { await request(app.getHttpServer()).get('/media/sources/owned').expect(401); });
it('streams private S3 bytes through ownership checks without a public bucket URL', async () => {
  const response = await request(app.getHttpServer()).get('/media/sources/owned').set('Cookie', 'cf_session=test-only').expect(200);
  expect(response.body.toString()).toBe(bytes.toString());
  expect(response.headers['cache-control']).toContain('private');
});
it('honors byte ranges through the real controller S3 delivery path', async () => {
  const response = await request(app.getHttpServer()).get('/media/sources/owned').set('Cookie', 'cf_session=test-only').set('Range', 'bytes=2-5').expect(206);
  expect(response.body.toString()).toBe(bytes.subarray(2, 6).toString());
  expect(storage.getStreamRange).toHaveBeenCalledWith('private/workspace-a/video.mp4', 2, 5);
});
it('rejects foreign IDs and does not provide a raw-key wildcard', async () => {
  await request(app.getHttpServer()).get('/media/sources/foreign').set('Cookie', 'cf_session=test-only').expect(404);
  await request(app.getHttpServer()).get('/media/private/workspace-a/video.mp4').set('Cookie', 'cf_session=test-only').expect(404);
});
