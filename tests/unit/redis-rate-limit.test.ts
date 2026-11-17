import { afterEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ eval: vi.fn(), on: vi.fn() }));
vi.mock('ioredis', () => ({ default: vi.fn(function () { return client; }) }));
vi.mock('../../apps/api/src/common/env', () => ({ env: { REDIS_URL: 'redis://test', REDIS_PREFIX: 'clipforge-test' } }));
import { RedisService, RATE_LIMIT_SCRIPT } from '../../apps/api/src/common/services/redis.service';
afterEach(() => vi.clearAllMocks());
describe('atomic rate-limit adapter', () => {
  it('uses one Lua command for counter and expiry, returning accurate budget', async () => {
    client.eval.mockResolvedValueOnce([2, 55]);
    const result = await new RedisService().hit('login:ip', 3, 60);
    expect(client.eval).toHaveBeenCalledWith(RATE_LIMIT_SCRIPT, 1, 'clipforge-test:ratelimit:login:ip', 60);
    expect(result).toEqual({ allowed: true, remaining: 1, resetSeconds: 55 });
  });
  it('denies over-budget requests and bounds remaining at zero', async () => {
    client.eval.mockResolvedValueOnce([6, 5]);
    expect(await new RedisService().hit('login:ip', 3, 60)).toEqual({ allowed: false, remaining: 0, resetSeconds: 5 });
  });
});
