/** Runs against a disposable real Redis when REDIS_TEST_BINARY points at redis-server. */
import 'reflect-metadata';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';

const config = vi.hoisted(() => ({ REDIS_URL: '', REDIS_PREFIX: '', HEALTHCHECK_TIMEOUT_MS: 4000 }));
vi.mock('../../apps/api/src/common/env', () => ({ env: config }));
import { RedisService } from '../../apps/api/src/common/services/redis.service';
import { RateLimitGuard } from '../../apps/api/src/common/guards/rate-limit.guard';

const binary = process.env.REDIS_TEST_BINARY;

describe.skipIf(!binary)('Redis security connection under real disconnects', () => {
  let dir = '';
  let server: ChildProcessWithoutNullStreams;
  let service: RedisService;
  let security: Redis;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clipforge-redis-test-'));
    config.REDIS_URL = join(dir, 'redis.sock');
    config.REDIS_PREFIX = `test-${randomUUID()}`;
    server = spawn(binary!, ['--port', '0', '--unixsocket', config.REDIS_URL, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no']);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Redis did not start: ${output}`)), 5000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Redis exited early: ${code}`)); });
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        if (/ready to accept connections/i.test(output)) { clearTimeout(timer); resolve(); }
      });
    });
    service = new RedisService();
    await service.onModuleInit();
    security = (service as unknown as { limiterClient: Redis }).limiterClient;
  });

  afterAll(async () => {
    if (service) await service.onModuleDestroy();
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('enforces an atomic budget under concurrency and repairs an orphaned TTL', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => service.hit('parallel', 8, 60)));
    expect(results.filter(result => result.allowed)).toHaveLength(8);
    expect(await service.client.get(service.key('ratelimit', 'parallel'))).toBe('20');
    const orphan = service.key('ratelimit', 'orphan');
    await service.client.set(orphan, '1');
    expect(await service.client.ttl(orphan)).toBe(-1);
    expect(await service.hit('orphan', 3, 60)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await service.client.ttl(orphan)).toBeGreaterThan(0);
  });

  it('fails closed immediately if the socket dies after readiness, without offline replay', async () => {
    expect(security.status).toBe('ready');
    const closed = once(security, 'close');
    security.stream.destroy(); // status may still say ready until the close event
    const headers: Record<string, string> = {};
    const context = {
      getHandler: () => ({}), getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', ip: '203.0.113.1' }),
        getResponse: () => ({ setHeader: (name: string, value: string) => { headers[name] = value; } }),
      }),
    };
    const guard = new RateLimitGuard({ getAllAndOverride: () => undefined } as never, service);
    const started = Date.now();
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(headers['retry-after']).toBe('5');
    await closed;
    expect(await service.pingRateLimiter()).toBe('PONG');
    expect(await service.client.get(service.key('ratelimit', 'default-unsafe:203.0.113.1'))).toBeNull();
    expect(await guard.canActivate(context as never)).toBe(true);
  });

  it('rejects a lost in-flight command instead of replaying it after reconnecting', async () => {
    // Pause Redis so the command is sent but cannot produce a reply before the socket closes.
    await service.client.call('CLIENT', 'PAUSE', '600', 'ALL');
    const pending = service.hit('inflight', 3, 60);
    // Attach the rejection handler immediately to avoid an unhandled rejection on disconnect.
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await new Promise(resolve => setTimeout(resolve, 30));
    const closed = once(security, 'close');
    security.stream.destroy();
    expect(await outcome).toBe('rejected');
    await closed;
    expect(await service.pingRateLimiter()).toBe('PONG');
    // The original command may have reached Redis before its reply was lost;
    // it must never be replayed as a second increment.
    const count = Number(await service.client.get(service.key('ratelimit', 'inflight')) ?? 0);
    expect(count).toBeLessThanOrEqual(1);
  });
});
