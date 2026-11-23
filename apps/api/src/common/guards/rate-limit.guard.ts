import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { RedisService } from '../services/redis.service';

/**
 * Redis-backed fixed-window limiter, per-user when authenticated and per-IP otherwise.
 *
 * Two budgets exist, on purpose:
 *
 *  - **The default.** Any *unsafe* request (anything but GET/HEAD/OPTIONS) is limited even when the
 *    route declares nothing. Previously a missing decorator meant "unlimited", which left 16 mutating
 *    routes — retry, publish, configuration writes, telegram linking — open to a stolen cookie
 *    looping expensive work. A route that legitimately needs more simply declares it.
 *  - **The declared budget.** `@RateLimit({...})` overrides the default for auth, uploads and other
 *    abuse-prone surfaces.
 *
 * Safe methods without a declared budget bypass Redis. All budgeted routes, including
 * explicitly limited GETs, fail closed with a retryable 503 if Redis is unavailable;
 * silently allowing authentication or mutations during an outage would remove abuse protection.
 */
const DEFAULT_BUDGET: RateLimitOptions = {
  limit: 120,
  windowSeconds: 60,
  scope: 'default-unsafe',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private lastUnavailableLogAt = 0;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { context?: { userId: string } }>();
    if (!declared && SAFE_METHODS.has(request.method)) return true;
    const options = declared ?? DEFAULT_BUDGET;
    const response = http.getResponse<Response>();
    // `request.context` is populated by the session guard, which runs after this one on some routes;
    // falling back to the IP keeps a defence in depth even when the user is not known yet.
    const identity = request.context?.userId ?? request.ip ?? 'unknown';
    const hit = async (identifier: string) => {
      try {
        return await this.redis.hit(identifier, options.limit, options.windowSeconds);
      } catch {
        // Redis errors can contain connection details: log only a static message,
        // and avoid flooding logs while the dependency remains down.
        if (Date.now() - this.lastUnavailableLogAt >= 30_000) {
          this.lastUnavailableLogAt = Date.now();
          this.logger.warn('Rate-limit store unavailable; protected requests are temporarily rejected.');
        }
        response.setHeader('retry-after', '5');
        throw new ServiceUnavailableException({ code: 'RATE_LIMIT_UNAVAILABLE', message: 'Request protection is temporarily unavailable; please retry.' });
      }
    };
    const { allowed, remaining, resetSeconds } = await hit(`${options.scope}:${identity}`);
    if (options.byIp && request.context?.userId) {
      const ipBudget = await hit(`${options.scope}:ip:${request.ip ?? 'unknown'}`);
      if (!ipBudget.allowed) {
        response.setHeader('retry-after', String(ipBudget.resetSeconds));
        throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many security requests from this address.' }, 429);
      }
    }
    response.setHeader('x-ratelimit-limit', String(options.limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(resetSeconds));
    if (!allowed) {
      response.setHeader('retry-after', String(resetSeconds));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: `Rate limit exceeded (${options.limit} per ${options.windowSeconds}s)` },
        429,
      );
    }
    return true;
  }
}
