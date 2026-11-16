import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
vi.mock('../../apps/api/src/common/env', () => ({ env: { HEALTHCHECK_TIMEOUT_MS: 30, AI_ENGINE_URL: 'http://ai', AI_ENGINE_API_KEY: 'test', VIDEO_PROCESSOR_URL: 'http://vp', VIDEO_PROCESSOR_API_KEY: 'test' } }));
import { boundedProbe, reportedServiceStatus } from '../../apps/api/src/common/health-probe';
import { SystemService } from '../../apps/api/src/system/system.service';
import { SystemController } from '../../apps/api/src/system/system.controller';
const healthy = (component: string) => ({ component, status: 'healthy' as const, message: 'private connection data', details: { host: 'private-host' } });
const service = new SystemService({} as never, {} as never, {} as never);
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('dependency readiness', () => {
  it('does not interpret an HTTP 200/down body as healthy', () => {
    expect(reportedServiceStatus(true, { status: 'down' })).toBe('down');
    expect(reportedServiceStatus(true, {})).toBe('down');
    expect(reportedServiceStatus(true, { status: 'ok', apiKeyConfigured: false })).toBe('unconfigured');
    expect(reportedServiceStatus(true, { status: 'ok', apiKeyConfigured: true })).toBe('healthy');
  });
  it('bounds a never-resolving probe', async () => {
    await expect(boundedProbe(() => new Promise(() => {}), 5)).rejects.toThrow('timed out');
  });
  it('respects video processor body status and config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'down', apiKeyConfigured: true }), { status: 200 })));
    expect((await service.videoProcessorHealth()).status).toBe('down');
  });
  it('requires actual processing worker roles even when all services are reachable', async () => {
    for (const [method, component] of [['databaseHealth', 'postgres'], ['redisHealth', 'redis'], ['storageHealth', 'storage'], ['aiEngineHealth', 'ai'], ['videoProcessorHealth', 'vp']] as const) vi.spyOn(service, method).mockResolvedValue(healthy(component));
    vi.spyOn(service, 'integrationHealth').mockReturnValue([healthy('gemini')]);
    vi.spyOn(service, 'workers').mockResolvedValue({ workers: [] });
    const readiness = await service.readiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.processingReady).toBe(false);
    expect(readiness.publishingReady).toBe(false);
  });
  it('returns a dependency report even when Redis worker discovery fails', async () => {
    for (const [method, component] of [['databaseHealth', 'postgres'], ['redisHealth', 'redis'], ['storageHealth', 'storage'], ['aiEngineHealth', 'ai'], ['videoProcessorHealth', 'vp']] as const) vi.spyOn(service, method).mockResolvedValue(healthy(component));
    vi.spyOn(service, 'integrationHealth').mockReturnValue([]);
    vi.spyOn(service, 'workers').mockRejectedValue(new Error('Redis offline'));
    expect((await service.readiness()).workers).toEqual([]);
  });
  it('sanitizes public failures and returns HTTP 503', async () => {
    vi.spyOn(service, 'health').mockResolvedValue({ status: 'degraded', uptimeSeconds: 1, version: '1', checks: [{ ...healthy('postgres'), status: 'down' }] });
    const res = { setHeader: vi.fn(), status: vi.fn() } as unknown as Response;
    const body = await new SystemController(service).health(res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body.checks).toEqual([{ component: 'postgres', status: 'down' }]);
    expect(JSON.stringify(body)).not.toContain('private');
  });
});
