import { afterEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ $connect: vi.fn(), $disconnect: vi.fn() }));
const connections = vi.hoisted(() => [] as Array<{ on: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>);
vi.mock('@clipforge/database', () => ({ prisma: db }));
vi.mock('ioredis', () => ({ default: vi.fn(function () {
  const connection = { on: vi.fn(), quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() };
  connections.push(connection); return connection;
}) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { REDIS_URL: 'redis://private-secret@host', REDIS_PREFIX: 'clipforge' } }));
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../apps/api/src/common/prisma.service';
import { RedisService } from '../../apps/api/src/common/services/redis.service';
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); connections.length = 0; });
it('fails database initialization with sanitized guidance and preserves the disconnect hook', async () => {
  const cause = new Error('connection refused'); db.$connect.mockRejectedValueOnce(cause);
  const service = new PrismaService();
  await expect(service.onModuleInit()).rejects.toMatchObject({ message: expect.stringContaining('PostgreSQL startup check failed') });
  try { await service.onModuleInit(); } catch (error) { expect(error).not.toHaveProperty('cause'); }
  await service.onModuleDestroy(); expect(db.$disconnect).toHaveBeenCalled();
});
it('reports Redis failures without exposing credentials and still closes both clients', async () => {
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const service = new RedisService();
  for (const connection of connections) {
    expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    connection.on.mock.calls[0][1](new Error('redis://private-secret@host'));
  }
  expect(error).toHaveBeenCalledWith(expect.stringContaining('Redis connection failed'));
  expect(JSON.stringify(error.mock.calls)).not.toContain('private-secret');
  await service.onModuleDestroy();
  for (const connection of connections) expect(connection.quit).toHaveBeenCalled();
});
