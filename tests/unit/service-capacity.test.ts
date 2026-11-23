import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@clipforge/database', () => ({
  prisma: { processingJob: { findUnique: mocks.findUnique } },
  JobLeaseLostError: class JobLeaseLostError extends Error {},
}));
vi.mock('../../apps/api/src/common/env', () => ({ env: {
  AI_ENGINE_URL: 'http://ai', AI_ENGINE_API_KEY: 'ai-key',
  VIDEO_PROCESSOR_URL: 'http://video', VIDEO_PROCESSOR_API_KEY: 'video-key',
} }));

import { JobLeaseLostError } from '@clipforge/database';
import { aiEngine, videoProcessor, ServiceCallError, ServiceCapacityError } from '../../apps/api/src/workers/services-client';
import { assertActiveJobLease, capacityAwareCalls, JobNoLongerActiveError, retryServiceCapacity } from '../../apps/api/src/workers/service-capacity';

const busyBody = { detail: { code: 'SERVICE_CAPACITY_EXHAUSTED', message: 'busy', retryable: true } };
const busyResponse = (status = 503, body: unknown = busyBody, retryAfter = '5') =>
  new Response(JSON.stringify(body), { status, headers: { 'retry-after': retryAfter } });

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue({ status: 'AI_ANALYSIS', workerId: 'worker:delivery', leaseExpiresAt: new Date(Date.now() + 60_000) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit pre-admission capacity response', () => {
  it.each([
    ['5', 5000], ['0', 1000], ['999', 30000], ['not a number', 5000],
  ])('recognizes the signal and bounds Retry-After %s', async (header, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(busyResponse(503, busyBody, header))));
    await expect(aiEngine.analyze({})).rejects.toMatchObject({
      service: 'ai-engine', status: 503, code: 'SERVICE_CAPACITY_EXHAUSTED', retryAfterMs: expected,
    });
    await expect(aiEngine.analyze({})).rejects.toBeInstanceOf(ServiceCapacityError);
  });

  it.each([
    ['generic 503', 503, { detail: { code: 'CONFIGURATION_REQUIRED', retryable: true } }],
    ['provider 429', 429, busyBody],
    ['upstream 502', 502, busyBody],
    ['missing retryable marker', 503, { detail: { code: 'SERVICE_CAPACITY_EXHAUSTED' } }],
    ['false retryable marker', 503, { detail: { code: 'SERVICE_CAPACITY_EXHAUSTED', retryable: false } }],
  ])('does not treat %s as a safe admission refusal', async (_name, status, body) => {
    const fetcher = vi.fn().mockResolvedValue(busyResponse(status, body));
    vi.stubGlobal('fetch', fetcher);
    let error: unknown;
    try { await retryServiceCapacity(() => videoProcessor.probe('/work/source'), { beforeRetry: vi.fn(), sleep: vi.fn() }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).not.toBeInstanceOf(ServiceCapacityError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not replay a network or timeout failure whose execution is ambiguous', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('socket disconnected'));
    vi.stubGlobal('fetch', fetcher);
    await expect(retryServiceCapacity(() => aiEngine.captions({}), { beforeRetry: vi.fn(), sleep: vi.fn() }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('capacity handling while the worker retains the same delivery and lease', () => {
  it('retries only the refused call with bounded jitter and keeps prior paid work intact', async () => {
    const analysis = vi.fn().mockResolvedValue({ plan: ['one'] });
    const captions = vi.fn()
      .mockRejectedValueOnce(new ServiceCapacityError('ai-engine', 5_000))
      .mockRejectedValueOnce(new ServiceCapacityError('ai-engine', 5_000))
      .mockRejectedValueOnce(new ServiceCapacityError('ai-engine', 5_000))
      .mockRejectedValueOnce(new ServiceCapacityError('ai-engine', 5_000))
      .mockResolvedValue({ captions: 'done' });
    const wait = vi.fn().mockResolvedValue(undefined);
    const check = vi.fn().mockResolvedValue(undefined);
    const notices = vi.fn();
    const result = await analysis();
    expect(await retryServiceCapacity(() => captions(result), {
      beforeRetry: check, sleep: wait, random: () => 0.2, onCapacity: notices,
    })).toEqual({ captions: 'done' });
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(captions).toHaveBeenCalledTimes(5);
    expect(captions.mock.calls.map(args => args[0])).toEqual([result, result, result, result, result]);
    expect(wait.mock.calls.map(args => args[0])).toEqual([5250, 10500, 21000, 31500]);
    expect(check).toHaveBeenCalledTimes(4);
    expect(notices).toHaveBeenCalledTimes(4);
  });

  it('checks cancellation or ownership after the delay and never resubmits after it changes', async () => {
    const operation = vi.fn().mockRejectedValue(new ServiceCapacityError('video-processor', 5_000));
    mocks.findUnique.mockResolvedValue({ status: 'CANCELLED', workerId: null, leaseExpiresAt: null });
    await expect(retryServiceCapacity(operation, {
      beforeRetry: () => assertActiveJobLease('job-a', 'worker:delivery'), sleep: async () => {},
    })).rejects.toBeInstanceOf(JobNoLongerActiveError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'job-a' }, select: { status: true, workerId: true, leaseExpiresAt: true },
    });
  });

  it.each(['CANCELLED', 'FAILED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION'])('stops for %s', async status => {
    mocks.findUnique.mockResolvedValue({ status, workerId: null, leaseExpiresAt: null });
    await expect(assertActiveJobLease('job-a', 'worker:delivery')).rejects.toBeInstanceOf(JobNoLongerActiveError);
  });
  it('stops if the row was deleted', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(assertActiveJobLease('job-a', 'worker:delivery')).rejects.toBeInstanceOf(JobNoLongerActiveError);
  });
  it.each([
    { workerId: 'other', leaseExpiresAt: new Date(Date.now() + 60_000) },
    { workerId: 'worker:delivery', leaseExpiresAt: null },
    { workerId: 'worker:delivery', leaseExpiresAt: new Date(Date.now() - 1) },
  ])('refuses a missing, expired, or changed lease', async fields => {
    mocks.findUnique.mockResolvedValue({ status: 'RENDERING', ...fields });
    await expect(assertActiveJobLease('job-a', 'worker:delivery')).rejects.toBeInstanceOf(JobLeaseLostError);
  });
  it('fails closed if the lease check cannot be read', async () => {
    const failure = new Error('database unavailable');
    mocks.findUnique.mockRejectedValue(failure);
    const operation = vi.fn().mockRejectedValue(new ServiceCapacityError('ai-engine', 5_000));
    await expect(retryServiceCapacity(operation, {
      beforeRetry: () => assertActiveJobLease('job-a', 'worker:delivery'), sleep: async () => {},
    })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('binds real retry checks and logging to the leased job', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const operation = vi.fn().mockRejectedValueOnce(new ServiceCapacityError('ai-engine', 5_000)).mockResolvedValue('ok');
    const pending = capacityAwareCalls('job-a', 'worker:delivery', logger)(operation);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(pending).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('job job-a: ai-engine is at capacity'));
  });
});
