import { ForbiddenException } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Explicit origins only. Host / forwarded-host are routing metadata, never trust anchors. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

export function createOriginPolicy(allowList: string): (origin: string) => boolean {
  const entries = allowList.split(',').map((value) => value.trim()).filter(Boolean);
  const patterns = entries.map((entry) => {
    // Only a complete subdomain label may be wildcarded; never suffix-match attacker domains.
    if (entry.includes('*')) {
      if (!/^https:\/\/\*\.[a-z0-9.-]+(?::\d+)?\/?$/i.test(entry)) throw new Error('Invalid ALLOWED_ORIGINS wildcard');
      const base = new URL(entry.replace('*.', ''));
      return (url: URL) => url.protocol === 'https:' && url.port === base.port && url.hostname.endsWith(`.${base.hostname}`) && url.hostname !== base.hostname;
    }
    const normalized = normalizeOrigin(entry);
    if (!normalized) throw new Error('ALLOWED_ORIGINS entries must be HTTP(S) origins without paths');
    return (url: URL) => url.origin === normalized;
  });
  if (!patterns.length) throw new Error('ALLOWED_ORIGINS must not be empty');
  return (origin) => {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && patterns.some((matches) => matches(new URL(normalized)));
  };
}

export function corsOptions(allowList: string): CorsOptions {
  const allowed = createOriginPolicy(allowList);
  return {
    origin: (origin, callback) => {
      if (!origin || allowed(origin)) return callback(null, true);
      return callback(new ForbiddenException({ code: 'ORIGIN_FORBIDDEN', message: 'Request blocked by origin check. Configure ALLOWED_ORIGINS with the frontend origin.' }), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  };
}
