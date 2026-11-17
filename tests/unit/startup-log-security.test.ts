import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
const logs = vi.hoisted(() => ({ child: vi.fn().mockReturnValue({ info: vi.fn() }) }));
vi.mock('../../apps/api/src/common/services/logger.service', () => ({ workerLogger: logs }));
vi.mock('../../apps/api/src/common/env', () => ({ env: {} }));
vi.mock('@clipforge/database', () => ({ prisma: {} }));
import { RequestIdInterceptor } from '../../apps/api/src/common/interceptors/request-id.interceptor';
import { NotificationsService } from '../../apps/api/src/notifications/notifications.service';
it('never logs OAuth code/state query parameters with completed requests', async () => {
  const req = { method: 'GET', path: '/api/accounts/youtube/callback', originalUrl: '/api/accounts/youtube/callback?code=private-secret&state=private-state' };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: vi.fn() }) }) };
  await lastValueFrom(new RequestIdInterceptor().intercept(context as never, { handle: () => of({ ok: true }) }));
  expect(logs.child).toHaveBeenCalledWith(expect.objectContaining({ path: req.path }));
  expect(JSON.stringify(logs.child.mock.calls)).not.toContain('private-secret');
});
it('defers notification retry to application bootstrap and suppresses driver exception text', async () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  try {
    const service = new NotificationsService();
    const retry = vi.spyOn(service, 'retryPending').mockRejectedValue(new Error('private-secret'));
    expect(retry).not.toHaveBeenCalled();
    service.onApplicationBootstrap(); await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Notification startup retry failed'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-secret');
  } finally { warn.mockRestore(); }
});
