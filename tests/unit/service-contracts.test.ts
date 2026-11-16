import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/api/src/common/env', () => ({ env: { VIDEO_PROCESSOR_URL: 'http://processor', VIDEO_PROCESSOR_API_KEY: 'test' } }));
import { videoProcessor } from '../../apps/api/src/workers/services-client';
afterEach(() => vi.unstubAllGlobals());
const report = () => ({ outputPath: '/work/clip.mp4', durationSeconds: 15, width: 1080, height: 1920, fps: 30, sizeBytes: 100000, videoCodec: 'h264', audioCodec: 'aac', bitrateKbps: 1200, framing: { mode: 'center_crop', trackedFrames: 0, totalFrames: 0, coverage: 0, fallbackUsed: false, note: '' }, subtitleWordCount: 25, subtitleStats: {}, audio: {}, validationErrors: [] });
describe('render service response contract', () => {
  it('accepts a validated render report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(report()))));
    expect(await videoProcessor.render({})).toMatchObject({ durationSeconds: 15, validationErrors: [] });
  });
  for (const [name, payload] of [['incomplete response', {}], ['validation errors', { ...report(), validationErrors: ['silent audio'] }], ['empty file', { ...report(), sizeBytes: 0 }], ['invalid dimensions', { ...report(), width: -1 }]]) {
    it(`rejects ${name} instead of marking a clip ready`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
      await expect(videoProcessor.render({})).rejects.toMatchObject({ code: 'INVALID_SERVICE_RESPONSE', retryable: false });
    });
  }
  it('rejects an HTML proxy response with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy</html>')));
    await expect(videoProcessor.render({})).rejects.toMatchObject({ code: 'INVALID_SERVICE_RESPONSE' });
  });
});
