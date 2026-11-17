import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ pathname: '/', loading: true, error: null as Error | null }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useSession: () => ({ isLoading: state.loading, data: undefined, error: state.error, refetch: vi.fn() }), useLogout: () => ({ mutate: vi.fn() }) }));
import { Shell } from '../../apps/web/components/shell';
beforeEach(() => { state.pathname = '/'; state.loading = true; state.error = null; });
const render = (bypass: boolean) => renderToStaticMarkup(createElement(Shell, { developmentBypass: bypass, children: createElement('div', null, 'Actual page content') }));
it.each(['/', '/jobs', '/jobs/owned-id', '/clips', '/create', '/settings', '/accounts', '/calendar', '/videos', '/publishing', '/brand', '/activity', '/admin'])('renders direct URL %s without authentication loading or a login interruption', pathname => {
  state.pathname = pathname;
  const html = render(true); expect(html).toContain('Actual page content'); expect(html).toContain('not signed in'); expect(html).not.toContain('Checking your session'); expect(html).not.toContain('Redirecting to sign in');
});
it('retains normal session gating with bypass off', () => { expect(render(false)).toContain('Checking your session'); expect(render(false)).not.toContain('Actual page content'); });
it('does not hide genuine backend failure', () => { state.loading = false; state.error = new Error('Actual backend failure'); expect(render(true)).toContain('Actual backend failure'); });
it('explains that account security still requires verified authentication', () => { state.pathname = '/security'; expect(render(true)).toContain('Account security requires a verified Telegram session'); });
