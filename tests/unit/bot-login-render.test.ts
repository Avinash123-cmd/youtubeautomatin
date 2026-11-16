import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ providers: { telegram: { enabled: true, missing: [] } } as unknown, status: { state: 'IDLE' } as Record<string, unknown>, error: null as Error | null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useSession: () => ({ data: { authenticated: false }, refetch: vi.fn(), isPending: false }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === 'bot-provider' ? state.providers : state.status, error: state.error, isPending: false, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
}));
import LoginPage from '../../apps/web/app/login/page';
beforeEach(() => { state.status = { state: 'IDLE' }; state.providers = { telegram: { enabled: true, missing: [] } }; state.error = null; });
const render = () => renderToStaticMarkup(createElement(LoginPage));
describe('Telegram-only login rendering (isolated hooks, no browser E2E)', () => {
  it('renders the premium single-provider interface without credential fields', () => {
    const html = render();
    expect(html).toContain('Continue with Telegram');
    expect(html).toContain('Long videos in.');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('Continue with Google');
  });
  it('restores a waiting transaction after refresh without storing the deep-link token', () => {
    state.status = { state: 'WAITING_FOR_TELEGRAM', expiresAt: new Date(Date.now() + 300000).toISOString() };
    expect(render()).toContain('Your login is still pending');
    expect(render()).toContain('Waiting for you to press Start');
  });
  it('shows identity confirmation only after approval', () => {
    state.status = { state: 'VERIFYING', expiresAt: new Date(Date.now() + 300000).toISOString(), identity: { displayName: 'Verified person', username: 'verified' } };
    expect(render()).toContain('Confirm and sign in');
    expect(render()).toContain('Verified person');
  });
  it('shows regeneration when the server reports expiry', () => { state.status = { state: 'EXPIRED' }; expect(render()).toContain('Generate a new login link'); });
  it('does not hide failed API calls', () => { state.error = new Error('API unreachable'); expect(render()).toContain('API unreachable'); expect(render()).toContain('Retry connection'); });
  it('does not call join on absent optional provider diagnostics', () => {
    state.providers = { telegram: { enabled: false, configured: false } };
    expect(render()).toContain('The API did not supply configuration details');
    expect(render()).toContain('data-auth-state="IDLE"');
  });
  it.each([null, {}, { telegram: null }, { telegram: { enabled: false, missing: 'not-an-array' } }, { telegram: { enabled: 'false' } }])('renders a useful contract error for malformed cached provider data: %j', value => {
    state.providers = value;
    expect(render()).toContain('Authentication API version mismatch');
    expect(render()).toContain('data-auth-state="FAILED"');
  });
  it('rejects cached invalid approval identity instead of crashing React rendering', () => {
    state.status = { state: 'VERIFYING', expiresAt: new Date(Date.now() + 300000).toISOString(), identity: { displayName: {} } };
    expect(render()).toContain('Authentication API version mismatch');
    expect(render()).not.toContain('Confirm and sign in');
  });

});
