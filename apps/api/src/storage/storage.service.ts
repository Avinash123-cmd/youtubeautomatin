import { StartupDependencyError } from '../common/startup-error';
import { randomUUID } from 'node:crypto';
import { boundedProbe } from '../common/health-probe';
import { BadRequestException, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from '../common/env';

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface MultipartUploadSession {
  key: string;
  uploadId: string | null;
  driver: 'local' | 's3';
  parts: Array<{ partNumber: number; url: string }>;
  expiresInSeconds: number;
}

/**
 * Object storage abstraction.
 *
 * `STORAGE_DRIVER` is explicit (env). There is no driver fallback: if S3 is
 * selected but misconfigured the API refuses to start (see env.ts).
 *
 * - s3   : private Cloudflare R2 / AWS S3, multipart uploads and bounded signed platform reads.
 * - local: persistent filesystem with session/workspace-protected /media ID routes.
 *          Production requires a real persistent mount. Instagram fetch needs S3;
 *          YouTube uploads bytes and does not require anonymous media access.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  readonly driver: 'local' | 's3';

  constructor() {
    this.driver = env.STORAGE_DRIVER;
    this.s3 =
      this.driver === 's3'
        ? new S3Client({
            region: env.S3_REGION!,
            endpoint: env.S3_ENDPOINT,
            forcePathStyle: env.S3_FORCE_PATH_STYLE ?? false,
            credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
          })
        : null;
  }

  async onModuleInit(): Promise<void> {
    try { await this.verifyReadWrite(); }
    catch { throw new StartupDependencyError('storage'); }
  }

  onModuleDestroy(): void { this.s3?.destroy(); }

  /** Verify actual bytes, not just a successful HEAD or a configured public URL. */
  async verifyReadWrite(): Promise<void> {
    const key = `health/${randomUUID()}.txt`;
    const expected = Buffer.from('clipforge storage probe');
    let stream: Readable | undefined;
    try {
      await boundedProbe(async () => {
        await this.putBuffer(key, expected, 'text/plain');
        stream = (await this.getStream(key)).stream;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > expected.length) throw new Error('Storage readback mismatch');
          chunks.push(bytes);
        }
        if (!Buffer.concat(chunks).equals(expected)) throw new Error('Storage readback mismatch');
      }, env.HEALTHCHECK_TIMEOUT_MS);
    } finally {
      stream?.destroy();
      await boundedProbe(() => this.delete(key), env.HEALTHCHECK_TIMEOUT_MS).catch(() => undefined);
    }
  }

  /** Rejects key traversal and absolute paths; keys are always workspace-scoped. */
  private assertSafeKey(key: string): void {
    if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Unsafe storage key: ${key}` });
    }
  }

  private localPath(key: string): string {
    this.assertSafeKey(key);
    const root = resolve(env.STORAGE_LOCAL_ROOT!);
    const full = resolve(join(root, normalize(key)));
    if (!full.startsWith(root + sep)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Storage key escapes storage root' });
    }
    return full;
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<StoredObject> {
    this.assertSafeKey(key);
    const info = await stat(filePath);
    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: info.size,
          ContentType: contentType,
        }),
      );
    } else {
      const target = this.localPath(key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(createReadStream(filePath), createWriteStream(target));
    }
    return { key, sizeBytes: info.size, contentType };
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      await this.s3!.send(new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Body: body, ContentType: contentType }));
    } else {
      const target = this.localPath(key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(Readable.from(body), createWriteStream(target));
    }
    return { key, sizeBytes: body.byteLength, contentType };
  }

  async getStream(key: string): Promise<{ stream: Readable; contentType?: string; contentLength?: number }> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const out = await this.s3!.send(new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      return {
        stream: out.Body as Readable,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
      };
    }
    const target = this.localPath(key);
    const info = await stat(target);
    return { stream: createReadStream(target), contentLength: info.size };
  }

  /** Object size without opening a body stream (needed to answer Range requests). */
  async statSize(key: string): Promise<number> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const out = await this.s3!.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      if (typeof out.ContentLength !== 'number') throw new Error(`Object ${key} has no content length`);
      return out.ContentLength;
    }
    return (await stat(this.localPath(key))).size;
  }

  /**
   * Streams an explicit byte range. Byte offsets are honoured by the storage layer itself —
   * returning the head of the file with a 206 status (which a client cannot detect until it
   * decodes the media) would silently break seeking.
   */
  async getStreamRange(key: string, start: number, end: number): Promise<{ stream: Readable; contentLength: number }> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const out = await this.s3!.send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Range: `bytes=${start}-${end}` }),
      );
      const length = out.ContentLength ?? end - start + 1;
      return { stream: out.Body as Readable, contentLength: length };
    }
    const target = this.localPath(key);
    const info = await stat(target);
    const from = Math.max(0, Math.min(start, info.size - 1));
    const to = Math.max(from, Math.min(end, info.size - 1));
    return { stream: createReadStream(target, { start: from, end: to }), contentLength: to - from + 1 };
  }

  /** Downloads an object to a local temp path — required by FFmpeg and upload APIs. */
  async downloadToFile(key: string, destination: string): Promise<number> {
    const { stream } = await this.getStream(key);
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(stream, createWriteStream(destination));
    return (await stat(destination)).size;
  }

  async exists(key: string): Promise<boolean> {
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      } else {
        await stat(this.localPath(key));
      }
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
      } else {
        await rm(this.localPath(key), { force: true });
      }
    } catch (error) {
      this.logger.warn('Storage deletion failed. Check storage permissions and service availability.');
    }
  }

  /**
   * Publicly reachable URL. Returns null when the active driver cannot provide
   * one — callers must treat that as a hard publishing blocker, not a fallback.
   */
  publicUrl(key: string): string | null {
    if (this.driver === 's3') {
      if (!env.S3_PUBLIC_BASE_URL) return null;
      return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
    }
    const base = env.STORAGE_LOCAL_PUBLIC_BASE_URL!;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  /** Bearer capability for an explicitly authorized platform fetch, never a browser preview URL.
   * Do not persist or log the returned URL. Local media routes require a session and cannot be
   * fetched by Instagram. S3 stays private; its provider must be reachable over public HTTPS.
   */
  async platformReadUrl(key: string, expiresIn = 3600): Promise<string | null> {
    this.assertSafeKey(key);
    if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 86400) {
      throw new BadRequestException('Platform media URL lifetime must be between 60 and 86400 seconds');
    }
    if (this.driver !== 's3') return null;
    const url = await getSignedUrl(this.s3!, new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }), { expiresIn });
    return new URL(url).protocol === 'https:' ? url : null;
  }

  /**
   * Multipart upload session. For S3 this returns presigned part URLs so the
   * browser streams bytes straight to the bucket. For the local driver the
   * client posts parts to POST /api/sources/upload/part.
   */
  async createMultipartUpload(key: string, contentType: string, partCount: number): Promise<MultipartUploadSession> {
    this.assertSafeKey(key);
    if (this.driver === 's3') {
      const created = await this.s3!.send(
        new CreateMultipartUploadCommand({ Bucket: env.S3_BUCKET!, Key: key, ContentType: contentType }),
      );
      if (!created.UploadId) throw new Error('S3 did not return an UploadId');
      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_, index) => ({
          partNumber: index + 1,
          url: await getSignedUrl(
            this.s3!,
            new UploadPartCommand({
              Bucket: env.S3_BUCKET!,
              Key: key,
              UploadId: created.UploadId!,
              PartNumber: index + 1,
            }),
            { expiresIn: 3600 },
          ),
        })),
      );
      return { key, uploadId: created.UploadId, driver: 's3', parts, expiresInSeconds: 3600 };
    }
    // Local driver: parts are appended by the API; the upload id is the storage key.
    return {
      key,
      uploadId: null,
      driver: 'local',
      parts: Array.from({ length: partCount }, (_, i) => ({
        partNumber: i + 1,
        url: `/api/sources/upload/part?key=${encodeURIComponent(key)}&partNumber=${i + 1}`,
      })),
      expiresInSeconds: 3600,
    };
  }

  async completeMultipartUpload(key: string, uploadId: string | null, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    if (this.driver !== 's3') return;
    if (!uploadId) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Missing uploadId for S3 multipart completion' });
    await this.s3!.send(
      new CompleteMultipartUploadCommand({
        Bucket: env.S3_BUCKET!,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (this.driver !== 's3') return;
    await this.s3!.send(new AbortMultipartUploadCommand({ Bucket: env.S3_BUCKET!, Key: key, UploadId: uploadId }));
  }

  /** Local-driver helper: append a received part to the staging file. */
  /**
   * Writes one upload part at its deterministic offset `(partNumber - 1) * partSize`.
   *
   * Parts arrive over independent HTTP requests and may be retried, reordered or lost. Appending
   * would corrupt the file in every one of those cases; writing at an offset makes each part
   * idempotent and order-independent. Sparse holes are detected at completion because the final
   * size must equal the declared size.
   */
  async writeLocalPartAt(stagingPath: string, offset: number, buffer: Buffer): Promise<number> {
    await mkdir(dirname(stagingPath), { recursive: true });
    // 'a+' would force every write to the end of the file (POSIX append semantics), which is
    // exactly the corruption we are removing — use a positional handle instead.
    const handle = await open(stagingPath, 'r+').catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return open(stagingPath, 'w+');
    });
    try {
      await handle.write(buffer, 0, buffer.length, offset);
      const { size } = await handle.stat();
      return size;
    } finally {
      await handle.close();
    }
  }

  /** Configuration capability check only: not proof the provider can fetch an object. */
  async expectPublicHttps(): Promise<{ ok: boolean; reason?: string }> {
    if (this.driver !== 's3') return { ok: false, reason: 'Instagram cannot fetch session-authenticated local media. Configure private S3-compatible storage with a publicly reachable HTTPS endpoint.' };
    const url = await this.platformReadUrl('health/probe.mp4');
    return url ? { ok: true } : { ok: false, reason: 'Platform media fetch requires a publicly reachable HTTPS S3 endpoint.' };
  }
}
