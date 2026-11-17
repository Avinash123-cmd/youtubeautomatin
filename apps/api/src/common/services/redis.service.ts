import { StartupDependencyError } from '../startup-error';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { boundedProbe } from '../health-probe';
import { env } from '../env';

/**
 * Redis is used for: rate limits, worker presence/heartbeats, queue metadata and
 * short-lived caches. It is never the source of truth for business state —
 * that lives in PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  readonly subscriber: Redis;

  constructor() {
    // API requests must fail boundedly during outages. Blocking BullMQ workers use separate clients.
    const options = { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 5000, enableReadyCheck: true, lazyConnect: false };
    this.client = new Redis(env.REDIS_URL, options);
    this.subscriber = new Redis(env.REDIS_URL, options);
    const logger = new Logger(RedisService.name);
    // Do not log the URL or driver message: either can contain credentials. Readiness stays red.
    for (const connection of [this.client, this.subscriber]) {
      connection.on('error', () => logger.error('Redis connection failed. Check REDIS_URL, TLS and network access; inspect /api/system/health before routing traffic.'));
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      const replies = await boundedProbe(() => Promise.all([this.client.ping(), this.subscriber.ping()]), env.HEALTHCHECK_TIMEOUT_MS);
      if (replies.some(reply => reply !== 'PONG')) throw new Error('Unexpected Redis response');
    } catch {
      throw new StartupDependencyError('redis');
    }
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
    await Promise.all([this.client, this.subscriber].map(async connection => {
      try { await boundedProbe(() => connection.quit(), env.HEALTHCHECK_TIMEOUT_MS); } catch { /* Force close below even during an outage. */ }
      finally { connection.disconnect(); }
    }));
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
