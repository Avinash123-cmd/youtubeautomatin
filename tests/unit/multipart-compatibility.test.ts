import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
vi.mock('@clipforge/database', () => ({ prisma: {}, ConfigurationRequiredError: class extends Error {} }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', UPLOAD_PART_SIZE_MIB: 16 } }));
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
import { SourcesController } from '../../apps/api/src/sources/sources.controller';
import { SourcesService } from '../../apps/api/src/sources/sources.service';
import { PrismaService } from '../../apps/api/src/common/prisma.service';
const receivePart = vi.fn().mockResolvedValue({ uploaded: true });
Reflect.defineMetadata('design:paramtypes', [SourcesService, PrismaService], SourcesController);
@Module({ controllers: [SourcesController], providers: [{ provide: SourcesService, useValue: { receivePart } }, { provide: PrismaService, useValue: {} }] })
class MultipartTestModule {}
let app: INestApplication;
beforeAll(async () => { app = await NestFactory.create(MultipartTestModule, { logger: false }); app.useGlobalFilters(new AllExceptionsFilter()); await app.init(); });
afterAll(async () => { await app.close(); });
it('keeps the actual Nest FileInterceptor compatible with patched Multer', async () => {
  await request(app.getHttpServer()).post('/api/sources/upload/part?sourceVideoId=source-a&partNumber=1').attach('chunk', Buffer.from('test-only-chunk'), 'part.bin').expect(201);
  expect(receivePart).toHaveBeenCalledWith('source-a', 1, Buffer.from('test-only-chunk'), undefined);
});
it('rejects unexpected multipart fields instead of passing them to the service', async () => {
  receivePart.mockClear();
  await request(app.getHttpServer()).post('/api/sources/upload/part?sourceVideoId=source-a&partNumber=1').attach('other', Buffer.from('test'), 'part.bin').expect(400);
  expect(receivePart).not.toHaveBeenCalled();
});
