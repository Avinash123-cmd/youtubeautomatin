import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const config = vi.hoisted(() => ({ WORK_DIR: '', UPLOAD_PART_SIZE_MIB: 16, NODE_ENV: 'test' }));
const db = vi.hoisted(() => ({ sourceVideo: { findFirst: vi.fn(), update: vi.fn() }, usageRecord: { create: vi.fn() } }));
const audit = vi.hoisted(() => vi.fn());
vi.mock('../../apps/api/src/common/env', () => ({ env: config }));
vi.mock('@clipforge/database', () => ({ prisma: db, appendAuditLog: audit }));
import { SourcesService } from '../../apps/api/src/sources/sources.service';

const sourceId = '00000000-0000-4000-8000-000000000123';
const ctx = { workspaceId: 'workspace', userId: 'user', ip: '127.0.0.1', userAgent: null } as never;
const rights = { accepted: true as const, statement: 'I own this file' };
const parts = [{ partNumber: 1, etag: 'etag' }];
const source = {
  id: sourceId, workspaceId: 'workspace', kind: 'UPLOAD', status: 'INITIATED', storageKey: 'workspace/source.mp4',
  sizeBytes: 10n, originalFileName: 'video.mp4', declaredMimeType: 'video/mp4', createdAt: new Date(),
  durationSeconds: null, width: null, height: null, frameRate: null, youTubeReferenceUrl: null, sourceUrl: null,
  rejectionReason: null, probeResult: null,
};
const report = { passed: true, issues: [], detectedMimeType: 'video/mp4', extension: '.mp4', sizeBytes: 10,
  probe: { duration_seconds: 10, width: 1280, height: 720, frame_rate: 30, video_codec: 'h264', audio_codec: 'aac' } };
const transient = () => new ServiceUnavailableException({ code: 'VIDEO_PROCESSOR_UNAVAILABLE', message: 'retry' });
let storage: { driver: string; completeMultipartUpload: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn>; downloadToFile: ReturnType<typeof vi.fn>; putFile: ReturnType<typeof vi.fn> };
let media: { validate: ReturnType<typeof vi.fn> };
let service: SourcesService;

beforeEach(async () => {
  vi.clearAllMocks();
  config.WORK_DIR = await mkdtemp(join(tmpdir(), 'cf-upload-retry-'));
  storage = {
    driver: 's3', completeMultipartUpload: vi.fn().mockResolvedValue(undefined), exists: vi.fn().mockResolvedValue(true),
    downloadToFile: vi.fn().mockImplementation(async (_key, destination) => { await writeFile(destination, Buffer.alloc(10)); return 10; }),
    putFile: vi.fn().mockResolvedValue(undefined),
  };
  media = { validate: vi.fn() };
  db.sourceVideo.findFirst.mockResolvedValue(source);
  db.sourceVideo.update.mockImplementation(async ({ data }) => ({ ...source, ...data }));
  db.usageRecord.create.mockResolvedValue({});
  audit.mockResolvedValue(undefined);
  const configService = { resolveForProcessing: vi.fn().mockResolvedValue({ maxFileSizeBytes: 1000, maxDurationSeconds: 60 }) };
  service = new SourcesService(storage as never, media as never, configService as never, {} as never);
});
afterEach(async () => { await rm(config.WORK_DIR, { recursive: true, force: true }); });

describe('retrying uploads after temporary probe failures', () => {
  it('keeps local staging and does not reject the source when the service is unavailable', async () => {
    storage.driver = 'local';
    const staging = join(config.WORK_DIR, 'uploads', `${sourceId}.part`);
    await mkdir(join(config.WORK_DIR, 'uploads'), { recursive: true });
    await writeFile(staging, Buffer.alloc(10, 42));
    media.validate.mockRejectedValueOnce(transient());
    await expect(service.completeUpload(sourceId, rights, ctx)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(staging)).toEqual(Buffer.alloc(10, 42));
    expect(db.sourceVideo.update.mock.calls.every(([call]) => call.data.status !== 'REJECTED')).toBe(true);
    expect(storage.putFile).not.toHaveBeenCalled();
  });

  it('reuses a completed S3 object on retry and cleans each unique validation file', async () => {
    const noSuchUpload = Object.assign(new Error('upload already completed'), { name: 'NoSuchUpload' });
    storage.completeMultipartUpload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(noSuchUpload);
    media.validate.mockRejectedValueOnce(transient()).mockResolvedValueOnce(report);
    await expect(service.completeUpload(sourceId, rights, ctx, parts, 'upload-id')).rejects.toMatchObject({ status: 503 });
    expect(await readdir(join(config.WORK_DIR, 'validation'))).toEqual([]);
    expect(db.sourceVideo.update.mock.calls.every(([call]) => call.data.status !== 'REJECTED')).toBe(true);

    const result = await service.completeUpload(sourceId, rights, ctx, parts, 'upload-id');
    expect(result.status).toBe('VALIDATED');
    expect(storage.exists).toHaveBeenCalledWith(source.storageKey);
    expect(storage.downloadToFile).toHaveBeenCalledTimes(2);
    const firstPath = storage.downloadToFile.mock.calls[0][1];
    const secondPath = storage.downloadToFile.mock.calls[1][1];
    expect(firstPath).not.toBe(secondPath);
    expect(await readdir(join(config.WORK_DIR, 'validation'))).toEqual([]);
  });

  it.each(['AccessDenied', 'NoSuchUpload'])('does not hide %s when the completed object cannot be confirmed', async name => {
    storage.completeMultipartUpload.mockRejectedValue(Object.assign(new Error('cannot complete'), { name }));
    storage.exists.mockResolvedValue(false);
    await expect(service.completeUpload(sourceId, rights, ctx, parts, 'upload-id')).rejects.toThrow('cannot complete');
    expect(storage.downloadToFile).not.toHaveBeenCalled();
    expect(media.validate).not.toHaveBeenCalled();
  });

  it('rejects a completed object whose size does not match the declared upload', async () => {
    storage.downloadToFile.mockImplementationOnce(async (_key, destination) => { await writeFile(destination, Buffer.alloc(5)); return 5; });
    await expect(service.completeUpload(sourceId, rights, ctx, parts, 'upload-id')).rejects.toMatchObject({ status: 400 });
    expect(media.validate).not.toHaveBeenCalled();
    expect(await readdir(join(config.WORK_DIR, 'validation'))).toEqual([]);
  });

  it('cleans the S3 validation destination even when downloading fails', async () => {
    storage.downloadToFile.mockImplementationOnce(async (_key, destination) => {
      await writeFile(destination, Buffer.alloc(3));
      throw new Error('storage interrupted');
    });
    await expect(service.completeUpload(sourceId, rights, ctx, parts, 'upload-id')).rejects.toThrow('storage interrupted');
    expect(media.validate).not.toHaveBeenCalled();
    expect(await readdir(join(config.WORK_DIR, 'validation'))).toEqual([]);
  });

  it('keeps local staging if the database fails after the object was written', async () => {
    storage.driver = 'local';
    const staging = join(config.WORK_DIR, 'uploads', `${sourceId}.part`);
    await mkdir(join(config.WORK_DIR, 'uploads'), { recursive: true });
    await writeFile(staging, Buffer.alloc(10, 42));
    media.validate.mockResolvedValueOnce(report);
    db.sourceVideo.update.mockImplementationOnce(async ({ data }) => ({ ...source, ...data })).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.completeUpload(sourceId, rights, ctx)).rejects.toThrow('database unavailable');
    expect(storage.putFile).toHaveBeenCalledOnce();
    expect(await readFile(staging)).toEqual(Buffer.alloc(10, 42));
  });
});
