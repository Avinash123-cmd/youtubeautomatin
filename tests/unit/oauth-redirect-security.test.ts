import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
vi.mock('../../apps/api/src/common/env', () => ({ env: { APP_URL: 'https://dashboard.example' } }));
import { AccountsController } from '../../apps/api/src/accounts/accounts.controller';
it('does not expose raw provider/DB exceptions or authorization descriptions in redirect URLs', async () => {
  const accounts = { handleYouTubeCallback: vi.fn().mockRejectedValue(new Error('access_token=private-secret')), handleInstagramCallback: vi.fn().mockRejectedValue(new Error('postgres://user:private-secret@host')) };
  const controller = new AccountsController(accounts as never);
  const response = { redirect: vi.fn(), setHeader: vi.fn() };
  await controller.youtubeCallback('code', 'state', undefined, response as never);
  await controller.instagramCallback('code', 'state', undefined, undefined, response as never);
  await controller.instagramCallback('code', 'state', 'denied', 'private-secret', response as never);
  expect(response.redirect.mock.calls.map(([url]) => url)).toEqual([
    'https://dashboard.example/accounts?oauth=error&reason=connection_failed',
    'https://dashboard.example/accounts?oauth=error&reason=connection_failed',
    'https://dashboard.example/accounts?oauth=error&reason=authorization_denied',
  ]);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(response.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
});
