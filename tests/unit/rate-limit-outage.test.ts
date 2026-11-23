import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/api/src/common/env', () => ({ env: {} }));
import { RateLimitGuard } from '../../apps/api/src/common/guards/rate-limit.guard';

function fixture(method: string, declared?: object) {
  const setHeader = vi.fn();
  const redis = { hit: vi.fn() };
  const reflector = { getAllAndOverride: () => declared };
  const context = {
    getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ method, ip: '203.0.113.1', context: { userId: 'user' } }), getResponse: () => ({ setHeader }) }),
  };
  return { guard: new RateLimitGuard(reflector as never, redis as never), context, redis, setHeader };
}

describe('rate limiter during a Redis outage', () => {
  it('leaves unbudgeted safe reads available without contacting Redis', async () => {
    const { guard, context, redis } = fixture('GET');
    redis.hit.mockRejectedValue(new Error('private connection string'));
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(redis.hit).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', undefined],
    ['GET', { limit: 5, windowSeconds: 60, scope: 'bot-login-status' }],
  ])('fails closed with a retryable, sanitized 503 for %s', async (method, declared) => {
    const { guard, context, redis, setHeader } = fixture(method, declared);
    redis.hit.mockRejectedValue(new Error('redis://secret:password@host'));
    let caught: any;
    try { await guard.canActivate(context as never); } catch (error) { caught = error; }
    expect(caught.status).toBe(503);
    expect(caught.getResponse()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(JSON.stringify(caught.getResponse())).not.toContain('password');
    expect(setHeader).toHaveBeenCalledWith('retry-after', '5');
  });

  it('also fails closed when the additional IP budget is unavailable', async () => {
    const { guard, context, redis } = fixture('POST', { limit: 5, windowSeconds: 60, scope: 'otp', byIp: true });
    redis.hit.mockResolvedValueOnce({ allowed: true, remaining: 4, resetSeconds: 20 }).mockRejectedValueOnce(new Error('down'));
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ status: 503 });
  });

  it('continues to return 429, not 503, for an exhausted budget', async () => {
    const { guard, context, redis, setHeader } = fixture('POST');
    redis.hit.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 9 });
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ status: 429 });
    expect(setHeader).toHaveBeenCalledWith('retry-after', '9');
  });
});
