import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = vi.hoisted(() => ({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: '', STORAGE_LOCAL_PUBLIC_BASE_URL: 'https://api.example.com/media' }));
const db = vi.hoisted(() => ({ sourceVideo: { findFirst: vi.fn() }, clipVariant: { findFirst: vi.fn() } }));
vi.mock('../../apps/api/src/common/env', () => ({ env: config }));
vi.mock('@clipforge/database', () => ({ prisma: db }));
import { StorageService } from '../../apps/api/src/storage/storage.service';
import { MediaController } from '../../apps/api/src/media/media.controller';
import { MediaValidationService } from '../../apps/api/src/media/media-validation.service';
import { PUBLIC_ROUTE } from '../../apps/api/src/common/decorators/auth.decorators';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cf-local-storage-')); config.STORAGE_LOCAL_ROOT = join(dir, 'missing', 'objects'); vi.clearAllMocks(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe('actual local filesystem adapter', () => {
  it('creates missing root/parents on write and reads bytes from the configured root', async () => {
    const storage = new StorageService();
    await storage.putBuffer('workspace-a/sources/video.mp4', Buffer.from('test-bytes'), 'video/mp4');
    expect(await readFile(join(config.STORAGE_LOCAL_ROOT, 'workspace-a/sources/video.mp4'), 'utf8')).toBe('test-bytes');
    const { stream } = await storage.getStream('workspace-a/sources/video.mp4');
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('test-bytes');
    const ranged = await storage.getStreamRange('workspace-a/sources/video.mp4', 0, 3);
    const partial = []; for await (const chunk of ranged.stream) partial.push(chunk);
    expect(Buffer.concat(partial).toString()).toBe('test');
  });
  it.each(['../outside', '/etc/passwd', 'workspace/../../outside', 'workspace\\outside', ''])('rejects unsafe object keys: %j', async key => {
    await expect(new StorageService().putBuffer(key, Buffer.from('blocked'), 'video/mp4')).rejects.toThrow();
  });
  it('atomically replaces an existing local object and leaves no staging file', async () => {
    const storage = new StorageService();
    const key = 'workspace/video.mp4';
    await storage.putBuffer(key, Buffer.from('old'), 'video/mp4');
    await storage.putBuffer(key, Buffer.from('complete-new-content'), 'video/mp4');
    expect(await readFile(join(config.STORAGE_LOCAL_ROOT, key), 'utf8')).toBe('complete-new-content');
    expect(await readdir(join(config.STORAGE_LOCAL_ROOT, 'workspace'))).toEqual(['video.mp4']);
  });
  it('preserves an existing object and cleans up staging when a file source fails', async () => {
    const storage = new StorageService();
    const key = 'workspace/video.mp4';
    await storage.putBuffer(key, Buffer.from('old'), 'video/mp4');
    const unreadable = join(dir, 'directory-as-file');
    await mkdir(unreadable);
    await expect(storage.putFile(key, unreadable, 'video/mp4')).rejects.toThrow();
    expect(await readFile(join(config.STORAGE_LOCAL_ROOT, key), 'utf8')).toBe('old');
    expect(await readdir(join(config.STORAGE_LOCAL_ROOT, 'workspace'))).toEqual(['video.mp4']);
  });
  it('does not leave a partial destination when a storage download fails', async () => {
    const storage = new StorageService();
    const destination = join(dir, 'download.mp4');
    await writeFile(destination, 'previous');
    const stream = new Readable({ read() { this.push('partial'); this.destroy(new Error('stream failed')); } });
    vi.spyOn(storage, 'getStream').mockResolvedValue({ stream });
    await expect(storage.downloadToFile('workspace/video.mp4', destination)).rejects.toThrow('stream failed');
    expect(await readFile(destination, 'utf8')).toBe('previous');
    expect((await readdir(dir)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
  it('constructs the existing media probe URL without inventing a static object mount', () => {
    expect(new StorageService().publicUrl('health/probe.mp4')).toBe('https://api.example.com/media/health/probe.mp4');
    expect(Reflect.getMetadata('path', MediaController)).toBe('media');
    expect(Reflect.getMetadata('path', MediaController.prototype.healthProbe)).toBe('health/probe.mp4');
    expect(Reflect.getMetadata(PUBLIC_ROUTE, MediaController.prototype.healthProbe)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_ROUTE, MediaController.prototype.source)).not.toBe(true);
    expect(Reflect.getMetadata(PUBLIC_ROUTE, MediaController.prototype.clipVariant)).not.toBe(true);
  });
  it('resolves source/clip IDs through workspace-scoped database queries, never arbitrary file paths', async () => {
    db.sourceVideo.findFirst.mockResolvedValue(null); db.clipVariant.findFirst.mockResolvedValue(null);
    const controller = new MediaController(new StorageService());
    const ctx = { workspaceId: 'workspace-a' } as never;
    await expect(controller.source('other-source', {} as never, {} as never, ctx)).rejects.toThrow();
    expect(db.sourceVideo.findFirst).toHaveBeenCalledWith({ where: { id: 'other-source', workspaceId: 'workspace-a' } });
    await expect(controller.clipVariant('other-variant', {} as never, {} as never, ctx)).rejects.toThrow();
    expect(db.clipVariant.findFirst.mock.calls[0][0].where).toEqual({ id: 'other-variant', clip: { workspaceId: 'workspace-a' } });
  });
  it('does not accept declared MIME alone and reports size/extension violations', async () => {
    const filePath = join(dir, 'fake.mp4'); await writeFile(filePath, 'this is not an mp4 container');
    const service = new MediaValidationService(); const probe = vi.spyOn(service, 'probe');
    const result = await service.validate({ filePath, originalFileName: 'fake.exe', declaredMimeType: 'video/mp4', sizeBytes: 100, maxFileSizeBytes: 10, maxDurationSeconds: 60 });
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('Extension'), expect.stringContaining('above the configured limit'), expect.stringContaining('File signature')]));
    expect(probe).not.toHaveBeenCalled();
  });
});
