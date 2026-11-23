import { afterEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ eval: vi.fn(), on: vi.fn(), status: 'ready' }));
vi.mock('ioredis', () => ({ default: vi.fn(function () { return client; }) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { REDIS_URL: 'redis://test', REDIS_PREFIX: 'clipforge-test' } }));
import Redis from 'ioredis';
import { RedisService, RATE_LIMIT_SCRIPT } from '../../apps/api/src/common/services/redis.service';
afterEach(() => { vi.clearAllMocks(); client.status = 'ready'; });
describe('atomic rate-limit adapter', () => {
  it('uses one Lua command for counter and expiry, returning accurate budget', async () => {
    client.eval.mockResolvedValueOnce([2, 55]);
    const result = await new RedisService().hit('login:ip', 3, 60);
    expect(client.eval).toHaveBeenCalledWith(RATE_LIMIT_SCRIPT, 1, 'clipforge-test:ratelimit:login:ip', 60);
    expect(result).toEqual({ allowed: true, remaining: 1, resetSeconds: 55 });
  });
  it('uses a dedicated connection that cannot queue or replay security commands after a disconnect', async () => {
    client.eval.mockResolvedValueOnce([1, 60]);
    await new RedisService().hit('login:ip', 3, 60);
    expect(vi.mocked(Redis).mock.calls.at(-1)?.[1]).toMatchObject({
      enableOfflineQueue: false, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0,
      commandTimeout: 5000,
    });
  });
  it('denies over-budget requests and bounds remaining at zero', async () => {
    client.eval.mockResolvedValueOnce([6, 5]);
    expect(await new RedisService().hit('login:ip', 3, 60)).toEqual({ allowed: false, remaining: 0, resetSeconds: 5 });
  });
  it.each([null, [], [1], [0, 60], ['1', 60], [1, NaN]])('rejects malformed Redis results instead of trusting them', async reply => {
    client.eval.mockResolvedValueOnce(reply);
    await expect(new RedisService().hit('login:ip', 3, 60)).rejects.toThrow('Invalid rate-limit store response');
  });
  it('does not queue a security check while Redis is reconnecting', async () => {
    client.status = 'reconnecting';
    await expect(new RedisService().hit('login:ip', 3, 60)).rejects.toThrow('unavailable');
    expect(client.eval).not.toHaveBeenCalled();
  });
});
