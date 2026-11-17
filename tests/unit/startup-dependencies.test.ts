import 'reflect-metadata';
import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ $connect: vi.fn(), $queryRaw: vi.fn(), $disconnect: vi.fn() }));
const redis = vi.hoisted(() => ({ ping: vi.fn(), on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
vi.mock('ioredis', () => ({ default: vi.fn(function () { return redis; }) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { HEALTHCHECK_TIMEOUT_MS: 15, STORAGE_DRIVER: 'local', REDIS_URL: 'redis://unused', STORAGE_LOCAL_ROOT: '/unused' } }));
import { PrismaService } from '../../apps/api/src/common/prisma.service';
import { RedisService } from '../../apps/api/src/common/services/redis.service';
import { StorageService } from '../../apps/api/src/storage/storage.service';
beforeEach(() => { vi.clearAllMocks(); db.$connect.mockResolvedValue(undefined); db.$queryRaw.mockResolvedValue([]); redis.ping.mockResolvedValue('PONG'); redis.quit.mockResolvedValue('OK'); });
it('requires a real application-schema query before PostgreSQL startup succeeds', async () => {
  await new PrismaService().onModuleInit();
  expect(db.$connect).toHaveBeenCalledOnce(); expect(db.$queryRaw).toHaveBeenCalledOnce();
});
it('bounds database startup and never propagates a credential-bearing driver exception', async () => {
  db.$connect.mockRejectedValue(new Error('postgres://user:private-secret@host'));
  await expect(new PrismaService().onModuleInit()).rejects.toThrow('PostgreSQL startup check failed');
  db.$connect.mockImplementation(() => new Promise(() => {}));
  await expect(new PrismaService().onModuleInit()).rejects.toThrow('timed out');
});
it('requires both Redis connections to answer PONG, not just construct successfully', async () => {
  const service = new RedisService(); await service.onModuleInit(); expect(redis.ping).toHaveBeenCalledTimes(2);
  redis.ping.mockResolvedValue('unexpected'); await expect(service.onModuleInit()).rejects.toThrow('Redis startup check failed');
});
it('bounds Redis shutdown even when QUIT never resolves', async () => {
  redis.quit.mockImplementation(() => new Promise(() => {}));
  await new RedisService().onModuleDestroy(); expect(redis.disconnect).toHaveBeenCalledTimes(2);
});
it('validates storage readback bytes and cleans its unique probe key', async () => {
  const service = new StorageService();
  const put = vi.spyOn(service, 'putBuffer').mockResolvedValue({ key: 'unused', sizeBytes: 23, contentType: 'text/plain' });
  vi.spyOn(service, 'getStream').mockResolvedValue({ stream: Readable.from([Buffer.from('clipforge storage probe')]) } as never);
  const remove = vi.spyOn(service, 'delete').mockResolvedValue(undefined);
  await service.onModuleInit(); expect(remove).toHaveBeenCalledWith(put.mock.calls[0][0]);
  vi.spyOn(service, 'getStream').mockResolvedValue({ stream: Readable.from([Buffer.from('wrong')]) } as never);
  await expect(service.onModuleInit()).rejects.toThrow('Storage startup check failed');
  expect(remove).toHaveBeenCalledTimes(2);
});

import { StartupDependencyError, startupFailureMessage } from '../../apps/api/src/common/startup-error';
it('provides actionable startup errors without forwarding arbitrary driver secrets', () => {
  expect(startupFailureMessage(new StartupDependencyError('postgres'))).toContain('DATABASE_URL');
  expect(startupFailureMessage(new Error('postgresql://user:private-secret@host'))).not.toContain('private-secret');
});
