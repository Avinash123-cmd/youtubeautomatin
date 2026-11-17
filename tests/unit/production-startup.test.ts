import 'reflect-metadata';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { envSchema } from '../../apps/api/src/common/env';
import { listenForApi } from '../../apps/api/src/common/http-listener';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const apiPackage = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
const portSchema = envSchema.pick({ PORT: true, API_PORT: true });
@Module({})
class NetworkOnlyModule {}

describe('production start architecture', () => {
  it('starts compiled JS without startup compilation or watch supervisors', () => {
    expect(existsSync('apps/api/dist/main.js')).toBe(true);
    expect(apiPackage.scripts['start:prod']).toBe('node dist/main.js');
    expect(rootPackage.scripts['start:api']).toBe('npm run start:prod -w @clipforge/api');
    expect(apiPackage.scripts.predev).toMatch(/^node .*dev-api.cjs --check && /);
    expect(apiPackage.scripts.prestart).toBeUndefined();
    expect(apiPackage.scripts['prestart:prod']).toBeUndefined();
    expect(readFileSync('render.api.yaml', 'utf8')).toContain('startCommand: npm run start:api');
    expect(readFileSync('.node-version', 'utf8').trim()).toBe('22.22.3');
  });
  it.each([{ NODE_ENV: 'production' }, { NODE_ENV: 'development', RENDER: 'true' }])('refuses the development watcher in a production deployment: %j', flags => {
    const result = spawnSync(process.execPath, ['scripts/dev-api.cjs'], { env: { ...process.env, ...flags }, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development watcher is forbidden');
    expect(result.stdout).not.toContain('watch mode');
  });
  it('validates ports, preserves API_PORT and supplies a local fallback', () => {
    expect(portSchema.parse({})).toEqual({ API_PORT: 4000 });
    expect(portSchema.parse({ PORT: '10000', API_PORT: '4000' })).toEqual({ PORT: 10000, API_PORT: 4000 });
    for (const PORT of ['', 'not-a-port', '0', '65536', '-1', '1.5']) expect(portSchema.safeParse({ PORT }).success).toBe(false);
  });
  it('uses host PORT in preference to local API_PORT and awaits bind success', async () => {
    const app = { listen: vi.fn().mockResolvedValue(undefined) };
    expect(await listenForApi(app as never, { PORT: 10000, API_PORT: 4000 })).toBe(10000);
    expect(app.listen).toHaveBeenCalledWith(10000, '0.0.0.0');
    app.listen.mockRejectedValueOnce(Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
    await expect(listenForApi(app as never, { API_PORT: 4000 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
  it('binds a real Nest HTTP server to all interfaces via the same production listener', async () => {
    // Port zero is ONLY for this isolated network test; production env validation forbids it.
    const app = await NestFactory.create(NetworkOnlyModule, { logger: false });
    try {
      await listenForApi(app, { PORT: 0, API_PORT: 4000 });
      expect(app.getHttpServer().address()).toMatchObject({ address: '0.0.0.0' });
    } finally { await app.close(); }
  });
  it('fails compiled production startup nonzero for missing configuration, without starting a watcher', () => {
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ['dist/main.js'], { cwd: 'apps/api', env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stdout).not.toContain('watch mode');
  });
});
