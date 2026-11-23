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
  private limiterClient: Redis | undefined;
  private limiterProbe: Promise<string> | undefined;
  private readonly logger = new Logger(RedisService.name);

  constructor() {
    // API requests must fail boundedly during outages. Blocking BullMQ workers use separate clients.
    const options = { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 5000, enableReadyCheck: true, lazyConnect: false };
    this.client = new Redis(env.REDIS_URL, options);
    this.subscriber = new Redis(env.REDIS_URL, options);
    for (const connection of [this.client, this.subscriber]) this.logConnectionErrors(connection);
  }

  private logConnectionErrors(connection: Redis): void {
    // Do not log the URL or driver message: either can contain credentials.
    connection.on('error', () => this.logger.error('Redis connection failed. Check REDIS_URL, TLS and network access; inspect /api/system/health before routing traffic.'));
  }

  private rateLimitConnection(): Redis {
    if (!this.limiterClient) {
      // Security checks must never be queued or replayed after a disconnect.
      // Keep these settings isolated from the application's general Redis client.
      this.limiterClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 0,
        connectTimeout: 5000,
        commandTimeout: 5000,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        lazyConnect: false,
      });
      this.logConnectionErrors(this.limiterClient);
    }
    return this.limiterClient;
  }

  /** Share concurrent probes so an outage does not accumulate Redis ready listeners. */
  pingRateLimiter(): Promise<string> {
    if (!this.limiterProbe) {
      this.limiterProbe = this.pingRateLimiterOnce().finally(() => { this.limiterProbe = undefined; });
    }
    return this.limiterProbe;
  }

  /** Wait only for initial/reconnecting readiness; command execution has its own deadline. */
  private async pingRateLimiterOnce(): Promise<string> {
    const connection = this.rateLimitConnection();
    if (connection.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          connection.removeListener('ready', onReady);
          connection.removeListener('end', onEnd);
          if (error) reject(error); else resolve();
        };
        const onReady = () => finish();
        const onEnd = () => finish(new Error('Rate-limit store unavailable'));
        const timer = setTimeout(() => finish(new Error('Rate-limit store unavailable')), env.HEALTHCHECK_TIMEOUT_MS);
        connection.once('ready', onReady);
        connection.once('end', onEnd);
        if (connection.status === 'ready') onReady();
        else if (connection.status === 'end') onEnd();
      });
    }
    return connection.ping();
  }

  async onModuleInit(): Promise<void> {
    try {
      const replies = await boundedProbe(() => Promise.all([this.client.ping(), this.subscriber.ping(), this.pingRateLimiter()]), env.HEALTHCHECK_TIMEOUT_MS);
      if (replies.some(reply => reply !== 'PONG')) throw new Error('Unexpected Redis response');
    } catch {
      throw new StartupDependencyError('redis');
    }
  }

  key(...parts: string[]): string {
    return [env.REDIS_PREFIX, ...parts].join(':');
  }

  async hit(identifier: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
    // Do not queue security checks while Redis is reconnecting. They must fail
    // immediately and be retried by the client rather than execute later.
    const connection = this.rateLimitConnection();
    if (connection.status !== 'ready') throw new Error('Rate-limit store unavailable');
    const key = this.key('ratelimit', identifier);
    const reply = await connection.eval(RATE_LIMIT_SCRIPT, 1, key, windowSeconds);
    if (!Array.isArray(reply) || reply.length !== 2 || !Number.isSafeInteger(reply[0]) || reply[0] < 1 || !Number.isSafeInteger(reply[1])) {
      throw new Error('Invalid rate-limit store response');
    }
    const [count, ttl] = reply as [number, number];
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds: ttl < 0 ? windowSeconds : ttl };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client, this.subscriber, ...(this.limiterClient ? [this.limiterClient] : [])].map(async connection => {
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
