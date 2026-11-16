import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../env';

/**
 * Redis is used for: rate limits, worker presence/heartbeats, queue metadata and
 * short-lived caches. It is never the source of truth for business state —
 * that lives in PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  readonly subscriber: Redis;

  constructor() {
    // API requests must fail boundedly during outages. Blocking BullMQ workers use separate clients.
    const options = { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 5000, enableReadyCheck: true, lazyConnect: false };
    this.client = new Redis(env.REDIS_URL, options);
    this.subscriber = new Redis(env.REDIS_URL, options);
  }

  key(...parts: string[]): string {
    return [env.REDIS_PREFIX, ...parts].join(':');
  }

  async hit(identifier: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
    const key = this.key('ratelimit', identifier);
    const [count, ttl] = await this.client.eval(RATE_LIMIT_SCRIPT, 1, key, windowSeconds) as [number, number];
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds: ttl < 0 ? windowSeconds : ttl };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
    await this.subscriber.quit().catch(() => undefined);
  }
}

/** Increment and TTL assignment must be atomic, including repair of old orphaned counters. */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;
