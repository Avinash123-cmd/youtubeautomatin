import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/common/env', () => ({ env: {
  VIDEO_PROCESSOR_URL: 'http://video-processor.test', VIDEO_PROCESSOR_API_KEY: 'test-key',
} }));
import { MediaValidationService } from '../../apps/api/src/media/media-validation.service';

const input = { filePath: '/work/video.mp4', originalFileName: 'video.mp4', declaredMimeType: 'video/mp4', sizeBytes: 128, maxFileSizeBytes: 1024, maxDurationSeconds: 60 };
const validProbe = {
  duration_seconds: 12, width: 1920, height: 1080, frame_rate: 30, rotation: 0,
  video_codec: 'h264', audio_codec: 'aac', container: 'mov,mp4',
  audio_channels: 2, audio_sample_rate: 48000, bit_rate: 10000, raw: {},
};
let service: MediaValidationService;

beforeEach(() => {
  service = new MediaValidationService();
  vi.spyOn(service, 'sniffFile').mockResolvedValue({ mime: 'video/mp4', label: 'MP4' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('media inspection dependency failures', () => {
  it('returns an inspection result and sends a bounded request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(validProbe), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const report = await service.validate(input);
    expect(report.passed).toBe(true);
    expect(report.probe).toMatchObject({ width: 1920, duration_seconds: 12 });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('records a real ffprobe rejection as invalid media', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'MEDIA_VALIDATION_FAILED', message: 'private server path' } }), { status: 422 })));
    const report = await service.validate(input);
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(['ffprobe could not read the file']);
    expect(JSON.stringify(report)).not.toContain('private server path');
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('network secret'))],
    ['server failure', () => Promise.resolve(new Response('private error', { status: 503 }))],
    ['probe capacity refusal', () => Promise.resolve(new Response(JSON.stringify({ detail: { code: 'SERVICE_CAPACITY_EXHAUSTED', retryable: true } }), { status: 503, headers: { 'retry-after': '5' } }))],
    ['bad service key', () => Promise.resolve(new Response('{}', { status: 401 }))],
    ['missing shared media path', () => Promise.resolve(new Response(JSON.stringify({ detail: { code: 'MEDIA_NOT_FOUND' } }), { status: 422 }))],
    ['invalid success JSON', () => Promise.resolve(new Response('not json', { status: 200 }))],
    ['malformed success', () => Promise.resolve(new Response(JSON.stringify({ width: 1080 }), { status: 200 }))],
  ])('does not mark media invalid for %s', async (_name, request) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(request));
    let caught: any;
    try { await service.validate(input); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 503, response: { code: 'VIDEO_PROCESSOR_UNAVAILABLE' } });
    expect(JSON.stringify(caught.response)).not.toMatch(/secret|private error/);
  });

  it('still rejects a successfully inspected file with no video stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...validProbe, video_codec: null }), { status: 200 })));
    const report = await service.validate(input);
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('No video stream found');
  });
});
