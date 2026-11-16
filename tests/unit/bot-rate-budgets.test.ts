import { describe, expect, it, vi } from 'vitest';
import { RateLimitGuard } from '../../apps/api/src/common/guards/rate-limit.guard';
vi.mock('../../apps/api/src/common/env', () => ({ env: {} }));
const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => ({ method: 'POST', context: { userId: 'owner' }, ip: '192.0.2.1' }), getResponse: () => ({ setHeader: vi.fn() }) }) };
describe('Telegram action OTP rate budgets (Redis adapter mocked)', () => {
  it('enforces account and IP budgets', async () => {
    const redis = { hit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetSeconds: 60 }) };
    const guard = new RateLimitGuard({ getAllAndOverride: () => ({ limit: 5, windowSeconds: 300, scope: 'telegram-action-otp', byIp: true }) } as never, redis as never);
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(redis.hit).toHaveBeenCalledWith('telegram-action-otp:owner', 5, 300);
    expect(redis.hit).toHaveBeenCalledWith('telegram-action-otp:ip:192.0.2.1', 5, 300);
  });
  it('rejects an exhausted IP even when the account has budget', async () => {
    const redis = { hit: vi.fn().mockResolvedValueOnce({ allowed: true, remaining: 4, resetSeconds: 60 }).mockResolvedValueOnce({ allowed: false, remaining: 0, resetSeconds: 30 }) };
    const guard = new RateLimitGuard({ getAllAndOverride: () => ({ limit: 5, windowSeconds: 300, scope: 'telegram-action-otp', byIp: true }) } as never, redis as never);
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ status: 429 });
  });
});
