import { afterEach, expect, it, vi } from 'vitest';
import { logUpstreamFailure, upstreamFailureCode } from '../../apps/web/lib/upstream-diagnostics';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
it.each([
  [{ cause: { code: 'ENOTFOUND' } }, 'UPSTREAM_DNS_FAILED'],
  [{ cause: { code: 'ECONNREFUSED' } }, 'UPSTREAM_CONNECTION_REFUSED'],
  [{ name: 'TimeoutError' }, 'UPSTREAM_TIMEOUT'],
  [{ code: 'secret-value' }, 'UPSTREAM_CONNECTION_FAILED'],
])('classifies failures without echoing error text: %j', (cause, expected) => {
  expect(upstreamFailureCode(cause)).toBe(expected);
});
it('logs only a sanitized origin and fixed diagnostic metadata', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logUpstreamFailure('https://user:secret@api.example.com/private?token=hidden', null, 15, 'UPSTREAM_DNS_FAILED');
  const output = JSON.stringify(warn.mock.calls);
  expect(output).toContain('https://api.example.com');
  for (const value of ['secret', 'user:', 'private', 'token', 'hidden']) expect(output).not.toContain(value);
});
it('reports the confirmed missing-target failure without exposing raw fetch errors', async () => {
  vi.stubEnv('CLIPFORGE_API_TARGET', 'https://api-not-configured.invalid');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('sensitive error content'), { cause: { code: 'ENOTFOUND' } })));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { GET } = await import('../../apps/web/app/healthz/route');
  const response = await GET(); const body = await response.json();
  expect(response.status).toBe(503);
  expect(body.upstream.failureCode).toBe('API_TARGET_NOT_CONFIGURED');
  expect(body.hint).toContain('Set API_INTERNAL_URL');
  expect(JSON.stringify([body, warn.mock.calls])).not.toContain('sensitive error content');
});
it('keeps a real healthy response successful and does not log a failure', async () => {
  vi.stubEnv('CLIPFORGE_API_TARGET', 'https://api.example.com');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ checks: [{ component: 'db' }] }))));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { GET } = await import('../../apps/web/app/healthz/route');
  expect((await GET()).status).toBe(200); expect(warn).not.toHaveBeenCalled();
});
