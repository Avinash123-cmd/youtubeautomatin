import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BackendDown } from '../../apps/web/components/backend-down';
import { afterEach, expect, it, vi } from 'vitest';
import { register } from '../../apps/web/instrumentation';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('checks the actual configured API readiness on Next startup', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs'); vi.stubEnv('CLIPFORGE_API_TARGET', 'http://127.0.0.1:4000');
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ checks: [{ component: 'db' }] })));
  vi.stubGlobal('fetch', fetcher); vi.spyOn(console, 'info').mockImplementation(() => {});
  await register();
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4000/api/system/health', expect.objectContaining({ cache: 'no-store' }));
});
it('warns rather than starting another backend or hiding failed readiness', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs'); vi.stubEnv('CLIPFORGE_API_TARGET', 'http://127.0.0.1:4000');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await register(); expect(warn).toHaveBeenCalledWith(expect.stringContaining('exactly one npm run dev:api'));
});

it('renders useful local backend guidance and a retry action', () => {
  const html = renderToStaticMarkup(createElement(BackendDown, { message: 'Backend unavailable', onRetry: () => {} }));
  expect(html).toContain('npm run dev:api');
  expect(html).toContain('API_PORT');
  expect(html).toContain('Retry');
});
