import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../../apps/api/src/common/env';
const original = process.env;
beforeEach(() => { process.env = {
  NODE_ENV: 'production', APP_URL: 'https://dashboard.example', ALLOWED_ORIGINS: 'https://dashboard.example', TIMEZONE: 'UTC',
  DATABASE_URL: 'postgresql://schema-check@db.internal/app', REDIS_URL: 'rediss://cache.internal:6379', REDIS_PREFIX: 'test-only',
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET: 'isolated-test-only-secret-not-deployable',
  STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: '/data/objects', STORAGE_LOCAL_PUBLIC_BASE_URL: 'https://api.example/media', WORK_DIR: '/data/work',
  AI_ENGINE_URL: 'http://ai:8100', AI_ENGINE_API_KEY: 'test-only', VIDEO_PROCESSOR_URL: 'http://processor:8200', VIDEO_PROCESSOR_API_KEY: 'test-only',
  TELEGRAM_BOT_TOKEN: `123456:${'x'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'test_only_bot', TELEGRAM_WEBHOOK_SECRET: 'test-only-webhook-secret',
}; resetEnvCache(); });
afterEach(() => { process.env = original; resetEnvCache(); });
it('accepts the complete isolated production-shaped configuration without network or fake startup', () => { expect(loadEnv().STORAGE_DRIVER).toBe('local'); });
it.each([
  ['APP_URL', 'https://name:secret@dashboard.example', 'APP_URL'],
  ['ALLOWED_ORIGINS', '*', 'ALLOWED_ORIGINS'],
  ['ALLOWED_ORIGINS', 'https://other.example', 'APP_URL'],
  ['TIMEZONE', 'not-a-timezone', 'TIMEZONE'],
  ['WORK_DIR', './relative', 'WORK_DIR'],
  ['STORAGE_LOCAL_ROOT', './relative', 'STORAGE_LOCAL_ROOT'],
  ['CREDENTIAL_ENCRYPTION_KEY', 'private-secret', 'CREDENTIAL_ENCRYPTION_KEY'],
  ['DATABASE_URL', 'postgresql://schema-check@127.0.0.1/app', 'DATABASE_URL'],
  ['REDIS_URL', 'redis://localhost', 'REDIS_URL'],
])('rejects invalid %s with actionable sanitized guidance', (name, value, message) => {
  process.env[name] = value;
  expect(() => loadEnv()).toThrow(message);
  try { loadEnv(); } catch (error) { expect(String(error)).not.toContain('private-secret'); }
});
