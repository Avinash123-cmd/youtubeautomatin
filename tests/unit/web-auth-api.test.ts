import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken } from '../../apps/web/lib/api';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => { setCsrfToken(null); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('browser authentication API client', () => {
  it('shares one CSRF bootstrap across concurrent initial mutations', async () => {
    fetchMock.mockImplementation(async (path) => path === '/api/auth/csrf' ? json({ csrfToken: 'one-token' }) : json({ ok: true }));
    await Promise.all([api('/api/auth/login', { method: 'POST', body: {} }), api('/api/auth/register', { method: 'POST', body: {} })]);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/csrf')).toHaveLength(1);
    for (const [, init] of fetchMock.mock.calls.filter(([path]) => path !== '/api/auth/csrf')) {
      expect(init.headers['x-csrf-token']).toBe('one-token');
      expect(init.credentials).toBe('include');
    }
  });
  it('preserves origin rejection from CSRF bootstrap', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request blocked by origin check.' } }, 403));
    await expect(api('/api/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 403, code: 'ORIGIN_FORBIDDEN', message: 'Request blocked by origin check.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('preserves structured provider-unavailable errors instead of mislabeling the API unreachable', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Retry Telegram later.' } }, 503));
    await expect(api('/api/auth/providers')).rejects.toMatchObject({ code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Retry Telegram later.' });
  });
  it('identifies non-JSON proxy errors as backend-unreachable', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api('/api/auth/session')).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE', status: 502 });
  });
  it('drops expired-session CSRF state before the next mutation', async () => {
    setCsrfToken('expired-session-token');
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'UNAUTHENTICATED' } }, 401));
    await expect(api('/api/auth/session')).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(json({ csrfToken: 'fresh-anonymous-token' })).mockResolvedValueOnce(json({ ok: true }));
    await api('/api/auth/login', { method: 'POST' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/csrf');
    expect(fetchMock.mock.calls[2][1].headers['x-csrf-token']).toBe('fresh-anonymous-token');
  });
});

it('invalidates a rejected CSRF token without replaying a state-changing request', async () => {
  setCsrfToken('expired-anonymous-token');
  fetchMock.mockResolvedValueOnce(json({ error: { code: 'CSRF_FAILED' } }, 403));
  await expect(api('/api/auth/login', { method: 'POST' })).rejects.toMatchObject({ code: 'CSRF_FAILED' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(json({ csrfToken: 'fresh-token' })).mockResolvedValueOnce(json({ ok: true }));
  await api('/api/auth/login', { method: 'POST' });
  expect(fetchMock.mock.calls[1]).toEqual(['/api/auth/csrf', { credentials: 'include', cache: 'no-store' }]);
  expect(fetchMock.mock.calls[2][1].headers['x-csrf-token']).toBe('fresh-token');
});
