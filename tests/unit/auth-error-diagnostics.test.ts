import { expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
const log = vi.hoisted(() => ({ error: vi.fn(), child: vi.fn() }));
vi.mock('../../apps/api/src/common/services/logger.service', () => ({ workerLogger: { child: log.child } }));
import { AllExceptionsFilter } from '../../apps/api/src/common/filters/all-exceptions.filter';
it('logs structured call sites and request identity without raw exception messages', () => {
  log.child.mockReturnValue({ error: log.error });
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ requestId: 'trace-123', method: 'GET', path: '/api/auth/providers' }) }) } as unknown as ArgumentsHost;
  const error = new TypeError('sensitive-provider-secret');
  new AllExceptionsFilter().catch(error, host);
  expect(response.status).toHaveBeenCalledWith(500);
  expect(response.json).toHaveBeenCalledWith({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: 'trace-123' } });
  expect(log.child).toHaveBeenCalledWith({ requestId: 'trace-123', method: 'GET', path: '/api/auth/providers' });
  expect(log.error.mock.calls[0][0]).toMatchObject({ errorType: 'TypeError', frames: expect.any(Array) });
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('sensitive-provider-secret');
});
