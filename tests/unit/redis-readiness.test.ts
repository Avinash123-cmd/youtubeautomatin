import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connections = vi.hoisted(() => [] as Array<any>);
vi.mock('ioredis', () => ({ default: vi.fn(function () {
  const connection = Object.assign(new EventEmitter(), {
    status: 'connecting', ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn(),
  });
  connections.push(connection);
  return connection;
}) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { REDIS_URL: 'redis://unused', REDIS_PREFIX: 'test', HEALTHCHECK_TIMEOUT_MS: 100 } }));
import { RedisService } from '../../apps/api/src/common/services/redis.service';
afterEach(() => { connections.length = 0; vi.clearAllMocks(); });

describe('rate-limit Redis readiness', () => {
  it('shares concurrent probes and cleans its listeners when the connection becomes ready', async () => {
    const service = new RedisService();
    const probes = Array.from({ length: 25 }, () => service.pingRateLimiter());
    const limiter = connections[2];
    expect(limiter.listenerCount('ready')).toBe(1);
    expect(limiter.listenerCount('end')).toBe(1);
    limiter.status = 'ready';
    limiter.emit('ready');
    expect(await Promise.all(probes)).toEqual(Array(25).fill('PONG'));
    expect(limiter.ping).toHaveBeenCalledTimes(1);
    expect(limiter.listenerCount('ready')).toBe(0);
    expect(limiter.listenerCount('end')).toBe(0);
    await service.onModuleDestroy();
  });

  it('cleans listeners on timeout and can recover on the next probe', async () => {
    const service = new RedisService();
    await expect(service.pingRateLimiter()).rejects.toThrow('unavailable');
    const limiter = connections[2];
    expect(limiter.listenerCount('ready')).toBe(0);
    expect(limiter.listenerCount('end')).toBe(0);
    limiter.status = 'ready';
    expect(await service.pingRateLimiter()).toBe('PONG');
    await service.onModuleDestroy();
  });
});
