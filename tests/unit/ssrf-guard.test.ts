import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';

const fakes = vi.hoisted(() => ({
  lookup: vi.fn(),
  port: 0,
  failAddresses: [] as string[],
  connections: [] as Array<{ address: string; family: number; hostname: string; host: string; protocol: string; agent: unknown }>,
}));

vi.mock('node:dns/promises', () => ({ lookup: fakes.lookup }));
// Transport is redirected to a local fixture server only in this test. Capture the
// production lookup callback before redirecting so we can check the pinned IP.
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    request: (url: URL, options: any, callback: any) => actual.request({
      // Preserve the logical hostname so Node invokes the real pinned lookup;
      // after recording its answer, redirect only the test socket to localhost.
      hostname: url.hostname, port: fakes.port, method: options.method, path: url.pathname + url.search,
      signal: options.signal, agent: false, family: options.family, autoSelectFamily: options.autoSelectFamily,
      headers: { ...options.headers, host: url.host },
      lookup: (hostname, lookupOptions, callback) => options.lookup(hostname, lookupOptions, (error: Error | null, address: string, family: number) => {
        fakes.connections.push({ address, family, hostname: url.hostname, host: url.host, protocol: url.protocol, agent: options.agent });
        callback(error, fakes.failAddresses.includes(address) ? '127.0.0.2' : '127.0.0.1', 4);
      }),
    }, callback),
  };
});
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return { request: http.request };
});

import { assertSafeOutboundUrl, downloadUrlToFile } from '../../apps/api/src/media/ssrf-guard';

let server: Server;
let directory: string;
const sockets = new Set<Socket>();
const opts = { requireHttps: false, maxBytes: 10, timeoutMs: 2_000 };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://rebound.example/secret' }); return res.end(); }
    if (req.url === '/redirect-public') { res.writeHead(302, { location: '/file?redirected=1' }); return res.end(); }
    if (req.url === '/redirect-http') { res.writeHead(302, { location: 'http://public.example/file' }); return res.end(); }
    if (req.url === '/delay-redirect') { setTimeout(() => { res.writeHead(302, { location: '/delay-response' }); res.end(); }, 70); return; }
    if (req.url === '/delay-response') { setTimeout(() => res.end('late'), 70); return; }
    if (req.url === '/header-stall') return;
    if (req.url === '/too-large') { res.writeHead(200, { 'content-length': '99' }); return res.end('oversized'); }
    if (req.url === '/chunked') { res.writeHead(200); res.write('012345'); return res.end('67890'); }
    if (req.url === '/broken') { res.writeHead(200, { 'content-length': '8' }); res.write('123'); return res.socket?.destroy(); }
    if (req.url === '/slow') { res.writeHead(200); res.write('abc'); return; }
    if (req.url === '/encoded') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end('data'); }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('hello');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  fakes.port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ssrf-test-'));
  fakes.connections.length = 0;
  fakes.failAddresses.length = 0;
  fakes.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const output = () => join(directory, 'video.mp4');

describe('outbound URL policy', () => {
  it.each([
    'http://127.0.0.1/a', 'http://0.0.0.0/a', 'http://10.1.2.3/a', 'http://100.64.0.1/a',
    'http://169.254.169.254/a', 'http://172.31.0.1/a', 'http://192.168.1.1/a', 'http://198.18.0.1/a',
    'http://224.0.0.1/a', 'http://[::1]/a', 'http://[fe90::1]/a', 'http://[fd00::1]/a',
    'http://[::ffff:127.0.0.1]/a', 'http://[::ffff:a00:1]/a', 'http://[2002:7f00:1::1]/a',
    'http://localhost./a', 'http://site.internal./a', 'http://foo.local/a', 'http://user:pass@example.com/a',
    'file:///etc/passwd',
  ])('rejects unsafe URL %s', async url => {
    await expect(assertSafeOutboundUrl(url, { requireHttps: false })).rejects.toMatchObject({ status: 400 });
    expect(fakes.lookup).not.toHaveBeenCalled();
  });

  it('rejects a DNS answer containing any private or IPv4-mapped address', async () => {
    fakes.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '::ffff:7f00:1', family: 6 }]);
    await expect(assertSafeOutboundUrl('https://mixed.example/x', { requireHttps: true })).rejects.toMatchObject({ status: 400 });
  });

  it('allows public addresses and requires HTTPS when configured', async () => {
    expect((await assertSafeOutboundUrl('https://example.com/x', { requireHttps: true })).resolvedIps).toEqual(['93.184.216.34']);
    expect((await assertSafeOutboundUrl('https://[2001:4860:4860::8888]/x', { requireHttps: true })).resolvedIps).toEqual(['2001:4860:4860::8888']);
    await expect(assertSafeOutboundUrl('http://example.com/x', { requireHttps: true })).rejects.toMatchObject({ status: 400 });
  });
});

describe('pinned and bounded downloads', () => {
  it('pins the first validated answer without resolving again and retains the original HTTPS host', async () => {
    fakes.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const result = await downloadUrlToFile('https://public.example/file', output(), { ...opts, requireHttps: true });
    expect(result).toMatchObject({ sizeBytes: 5, contentType: 'video/mp4', finalUrl: 'https://public.example/file' });
    expect(await readFile(output(), 'utf8')).toBe('hello');
    expect(fakes.lookup).toHaveBeenCalledTimes(1);
    expect(fakes.connections).toEqual([{ address: '93.184.216.34', family: 4, hostname: 'public.example', host: 'public.example', protocol: 'https:', agent: false }]);
    expect(await readdir(directory)).toEqual(['video.mp4']);
  });

  it('tries another validated address when the first cannot connect', async () => {
    fakes.failAddresses.push('93.184.216.34');
    fakes.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    await downloadUrlToFile('http://public.example/file', output(), opts);
    expect(fakes.connections.map(connection => connection.address)).toEqual(['93.184.216.34', '1.1.1.1']);
    expect(fakes.lookup).toHaveBeenCalledTimes(1);
    expect(await readFile(output(), 'utf8')).toBe('hello');
  });

  it('revalidates each redirect and pins its new DNS answer', async () => {
    fakes.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    const result = await downloadUrlToFile('http://public.example/redirect-public', output(), opts);
    expect(result.finalUrl).toBe('http://public.example/file?redirected=1');
    expect(fakes.connections.map(connection => connection.address)).toEqual(['93.184.216.34', '1.1.1.1']);
    expect(fakes.lookup).toHaveBeenCalledTimes(2);
  });

  it('rejects redirects to a private DNS answer or an HTTPS downgrade', async () => {
    fakes.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(downloadUrlToFile('http://public.example/redirect-private', output(), opts)).rejects.toMatchObject({ status: 400 });
    expect(fakes.connections).toHaveLength(1);
    fakes.connections.length = 0;
    await expect(downloadUrlToFile('https://public.example/redirect-http', output(), { ...opts, requireHttps: true })).rejects.toMatchObject({ status: 400 });
    expect(fakes.connections).toHaveLength(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['/too-large', '/chunked', '/broken', '/encoded'])('does not publish partial output for %s', async path => {
    await writeFile(output(), 'previous');
    await expect(downloadUrlToFile(`http://public.example${path}`, output(), opts)).rejects.toMatchObject({ status: 400 });
    expect(await readFile(output(), 'utf8')).toBe('previous');
    expect(await readdir(directory)).toEqual(['video.mp4']);
  });

  it('enforces the deadline over a stalled response body and cleans up', async () => {
    await expect(downloadUrlToFile('http://public.example/slow', output(), { ...opts, timeoutMs: 100 })).rejects.toMatchObject({ status: 400 });
    expect(await readdir(directory)).toEqual([]);
  });

  it('covers stalled headers and the combined duration of all redirects', async () => {
    await expect(downloadUrlToFile('http://public.example/header-stall', output(), { ...opts, timeoutMs: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(downloadUrlToFile('http://public.example/delay-redirect', output(), { ...opts, timeoutMs: 110 })).rejects.toMatchObject({ status: 400 });
    expect(await readdir(directory)).toEqual([]);
  });

  it('enforces the same deadline while DNS never resolves', async () => {
    fakes.lookup.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(downloadUrlToFile('http://public.example/file', output(), { ...opts, timeoutMs: 100 })).rejects.toMatchObject({ status: 400 });
    expect(fakes.connections).toHaveLength(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
