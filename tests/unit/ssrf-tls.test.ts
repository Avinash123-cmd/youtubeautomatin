import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';

const fakes = vi.hoisted(() => ({ lookup: vi.fn(), ca: '', trustFixture: true, pinned: [] as string[] }));
vi.mock('node:dns/promises', () => ({ lookup: fakes.lookup }));
vi.mock('node:https', async importOriginal => {
  const https = await importOriginal<typeof import('node:https')>();
  return {
    ...https,
    request: (url: URL, options: any, callback: any) => https.request(url, {
      ...options,
      // Trust the ephemeral test CA only for this fixture; production options
      // remain unchanged and still use Node's certificate and hostname checks.
      ...(fakes.trustFixture ? { ca: fakes.ca } : {}),
      lookup: (hostname: string, lookupOptions: any, callback: any) => options.lookup(hostname, lookupOptions, (error: Error | null, address: string) => {
        fakes.pinned.push(address);
        callback(error, '127.0.0.1', 4); // only the test transport is redirected
      }),
    }, callback),
  };
});
import { downloadUrlToFile } from '../../apps/api/src/media/ssrf-guard';

let opensslAvailable = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslAvailable = false; }

describe.skipIf(!opensslAvailable)('pinned HTTPS transport', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let observedHost = '';
  let observedSni = '';
  const output = () => join(dir, 'output.mp4');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ssrf-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=public.example',
      '-addext', 'subjectAltName=DNS:public.example'], { stdio: 'ignore' });
    const key = await readFile(join(dir, 'key.pem'));
    const cert = await readFile(join(dir, 'cert.pem'));
    fakes.ca = cert.toString();
    server = createServer({ key, cert }, (request, response) => {
      observedHost = request.headers.host ?? '';
      observedSni = (request.socket as import('node:tls').TLSSocket).servername || '';
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end('valid');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fakes.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fakes.pinned.length = 0;
    fakes.trustFixture = true;
    observedHost = '';
    observedSni = '';
    await rm(output(), { force: true });
  });

  it('uses the validated address while preserving the original Host, SNI and valid certificate', async () => {
    await downloadUrlToFile(`https://public.example:${port}/video`, output(), { requireHttps: true, maxBytes: 100, timeoutMs: 3000 });
    expect(await readFile(output(), 'utf8')).toBe('valid');
    expect(fakes.pinned).toEqual(['93.184.216.34']);
    expect(fakes.lookup).toHaveBeenCalledTimes(1);
    expect(observedHost).toBe(`public.example:${port}`);
    expect(observedSni).toBe('public.example');
  });

  it('rejects a validly signed certificate for a different hostname', async () => {
    await expect(downloadUrlToFile(`https://wrong.example:${port}/video`, output(), { requireHttps: true, maxBytes: 100, timeoutMs: 3000 })).rejects.toMatchObject({ status: 400 });
    await expect(readFile(output())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an untrusted self-signed certificate', async () => {
    fakes.trustFixture = false;
    await expect(downloadUrlToFile(`https://public.example:${port}/video`, output(), { requireHttps: true, maxBytes: 100, timeoutMs: 3000 })).rejects.toMatchObject({ status: 400 });
    await expect(readFile(output())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
