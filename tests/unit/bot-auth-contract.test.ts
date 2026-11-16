import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBotProviders, loadBotStatus, createBotChallenge, completeBotLogin } from '../../apps/web/lib/bot-auth-api';
import { setCsrfToken } from '../../apps/web/lib/api';
import { botProvidersResponseSchema, botLoginStatusResponseSchema } from '@clipforge/validation';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null); });
describe('runtime authentication response validation', () => {
  it('defaults only absent optional diagnostics, without inventing enabled/configured flags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ telegram: { enabled: false, configured: false } })));
    expect(await loadBotProviders()).toEqual({ telegram: { enabled: false, configured: false, missing: [] } });
  });
  it.each([null, [], {}, { telegram: null }, { telegram: { enabled: false, missing: null } }, { telegram: { enabled: 'false' } }, { password: true, telegram: { enabled: false } }, { telegram: { enabled: true, configured: false } }])('rejects invalid discovery payload %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload)));
    await expect(loadBotProviders()).rejects.toMatchObject({ code: 'AUTH_CONTRACT_MISMATCH', status: 502 });
  });
  it('keeps genuine backend errors and request IDs instead of replacing them with contract errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin rejected', requestId: 'origin-trace' } }, 403)));
    await expect(loadBotProviders()).rejects.toMatchObject({ code: 'ORIGIN_FORBIDDEN', requestId: 'origin-trace' });
  });
  it('diagnoses an absent status route rather than polling or guessing another endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'NOT_FOUND', requestId: 'route-trace' } }, 404));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadBotStatus()).rejects.toMatchObject({ code: 'AUTH_ROUTE_MISSING', status: 404, requestId: 'route-trace', message: expect.stringContaining('API_INTERNAL_URL') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([{ state: 'WAITING_FOR_TELEGRAM' }, { state: 'VERIFYING', expiresAt: new Date().toISOString() }, { state: 'UNKNOWN' }, { state: 'WAITING_FOR_TELEGRAM', expiresAt: 'bad' }])('rejects status that cannot safely drive polling: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload)));
    await expect(loadBotStatus()).rejects.toMatchObject({ code: 'AUTH_CONTRACT_MISMATCH' });
  });
  it('accepts all documented server states', () => {
    const expiresAt = new Date().toISOString();
    for (const payload of [{ state: 'IDLE' }, { state: 'EXPIRED' }, { state: 'WAITING_FOR_TELEGRAM', expiresAt, identity: null }, { state: 'VERIFYING', expiresAt, identity: { displayName: 'Verified person', username: null } }]) expect(botLoginStatusResponseSchema.safeParse(payload).success).toBe(true);
    expect(botProvidersResponseSchema.parse({ telegram: { enabled: true, configured: true } }).telegram.missing).toEqual([]);
  });
  it('validates challenge links before exposing an actionable Telegram link', async () => {
    setCsrfToken('test-csrf');
    const valid = { deepLink: `https://t.me/ClipForgeBot?start=login_${'a'.repeat(43)}`, expiresAt: new Date(Date.now() + 300000).toISOString() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(valid)).mockResolvedValueOnce(json({ ...valid, deepLink: 'javascript:alert(1)' })));
    expect(await createBotChallenge()).toEqual(valid);
    await expect(createBotChallenge()).rejects.toMatchObject({ code: 'AUTH_CONTRACT_MISMATCH' });
  });
  it('requires confirmed authentication and a new CSRF token before navigating', async () => {
    setCsrfToken('test-csrf');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ authenticated: false })));
    await expect(completeBotLogin()).rejects.toMatchObject({ code: 'AUTH_CONTRACT_MISMATCH' });
  });
});
