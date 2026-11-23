import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, completeSourceUpload, setCsrfToken, uploadSource, UploadValidationPendingError } from '../../apps/web/lib/api';

const source = { id: 'source-id', status: 'VALIDATED', durationSeconds: 10, width: 1280, height: 720 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const unavailable = () => response({ error: { code: 'VIDEO_PROCESSOR_UNAVAILABLE', message: 'Try again' } }, 503);

beforeEach(() => setCsrfToken('test-csrf'));
afterEach(() => { setCsrfToken(null); vi.unstubAllGlobals(); });

describe('browser retry after media inspection outage', () => {
  it.each(['local', 's3'] as const)('reuses the %s completion data without uploading parts again', async driver => {
    let completionAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/initiate')) return response({
        sourceVideoId: 'source-id', partSizeBytes: 2, driver,
        parts: [{ partNumber: 1, url: '/part-1' }, { partNumber: 2, url: '/part-2' }],
        uploadId: driver === 's3' ? 's3-upload-id' : null, maxFileSizeBytes: 100,
      });
      if (url.startsWith('/part-')) {
        expect(options?.method).toBe(driver === 's3' ? 'PUT' : 'POST');
        return new Response('ok', { headers: { etag: `etag-${url.slice(-1)}` } });
      }
      if (url.endsWith('/complete')) {
        completionAttempts += 1;
        return completionAttempts === 1 ? unavailable() : response(source);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const file = new File(['abcd'], 'video.mp4', { type: 'video/mp4' });
    const progress = vi.fn();
    let pending: UploadValidationPendingError | undefined;
    try { await uploadSource(file, { rightsStatement: 'I own it', onProgress: progress }); }
    catch (error) { if (error instanceof UploadValidationPendingError) pending = error; else throw error; }
    expect(pending).toBeInstanceOf(UploadValidationPendingError);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'validating', percent: 100 });
    expect(pending!.completion).toEqual({
      sourceVideoId: 'source-id',
      ...(driver === 's3' ? { uploadId: 's3-upload-id', parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }] } : {}),
    });
    expect(await completeSourceUpload(pending!.completion, 'I still own it')).toEqual(source);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/initiate'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/part-'))).toHaveLength(2);
    const completeCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/complete'));
    expect(completeCalls).toHaveLength(2);
    expect(JSON.parse(String(completeCalls[1][1]?.body))).toMatchObject({
      ...pending!.completion, rightsDeclaration: { accepted: true, statement: 'I still own it' },
    });
  });

  it.each([
    ['proxy error', () => Promise.resolve(new Response('proxy unavailable', { status: 503 }))],
    ['network failure', () => Promise.reject(new Error('connection lost'))],
    ['another dependency', () => Promise.resolve(response({ error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Try later' } }, 503))],
    ['invalid media', () => Promise.resolve(response({ error: { code: 'MEDIA_VALIDATION_FAILED', message: 'Invalid' } }, 400))],
  ])('does not offer an unsafe completion retry after %s', async (_label, result) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(result));
    const error = await completeSourceUpload({ sourceVideoId: 'source-id' }, 'I own it').catch(value => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(UploadValidationPendingError);
  });
});
