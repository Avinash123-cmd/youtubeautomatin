import { expect, it } from 'vitest';
import { validateProductionConnections } from '../../apps/api/src/common/env';
const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.internal/app', REDIS_URL: 'rediss://user:secret@cache.internal:6379' };
it('allows real internal hostnames without assuming services are reachable', () => { expect(() => validateProductionConnections(base)).not.toThrow(); });
it.each(['localhost', '127.0.0.1', '127.12.1.1', '[::1]', '0.0.0.0', 'x.localhost'])('rejects production loopback %s without logging credentials', host => {
  expect(() => validateProductionConnections({ ...base, DATABASE_URL: `postgresql://user:secret@${host}/app` })).toThrow('DATABASE_URL must not point');
  expect(() => validateProductionConnections({ ...base, REDIS_URL: `redis://user:secret@${host}` })).toThrow('REDIS_URL must not point');
  try { validateProductionConnections({ ...base, REDIS_URL: `redis://user:secret@${host}` }); } catch (error) { expect(String(error)).not.toContain('secret'); }
});
it('preserves local development and validates production URL protocols', () => {
  expect(() => validateProductionConnections({ ...base, NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' })).not.toThrow();
  expect(() => validateProductionConnections({ ...base, REDIS_URL: 'https://cache.internal' })).toThrow('REDIS_URL');
});
