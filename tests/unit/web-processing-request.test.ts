import { describe, expect, it } from 'vitest';
import { createJobSchema } from '@clipforge/validation';
import { processingRequest } from '../../apps/web/lib/processing-request';
const id = '1b726681-2718-4545-8874-0758f0303f12';
const values = { 'render.framing_mode': 'center_crop', 'render.framing_fallback': 'fail', 'subtitles.preset_id': id, 'subtitles.language': 'en', 'content.languages': ['en'], 'ai.max_output_clips': 6, 'ai.min_quality_score': 70 };
describe('browser-to-job API contract', () => {
  it('constructs the real sourceVideoId/configuration request accepted by Nest', () => {
    const request = processingRequest(id, values, [15, 30]);
    expect(createJobSchema.parse(request)).toEqual(request);
    expect(request.sourceVideoId).toBe(id);
    expect(request).not.toHaveProperty('sourceId');
  });
  it('preserves explicit target durations and never automatically publishes', () => {
    const request = processingRequest(id, values, [30]);
    expect(request.configuration.targetDurations).toEqual([30]);
    expect(request.configuration.autoPublish).toBe(false);
    expect(request.configuration.platforms).toEqual([]);
  });
  it('refuses incomplete workspace settings before uploading bytes', () => {
    expect(() => processingRequest(id, {}, [15])).toThrow('Processing settings');
  });
  it('requires a duration and a real preset rather than inventing IDs', () => {
    expect(() => processingRequest(id, values, [])).toThrow();
    expect(() => processingRequest(id, { ...values, 'subtitles.preset_id': 'missing' }, [15])).toThrow();
  });
});

import { RIGHTS_DECLARATIONS } from '../../apps/web/lib/source-rights';
import { completeUploadSchema, importUrlSchema } from '@clipforge/validation';
describe('rights declaration API compatibility', () => {
  for (const option of RIGHTS_DECLARATIONS) it(`accepts the displayed declaration: ${option.label}`, () => {
    const rightsDeclaration = { accepted: true, statement: option.value };
    expect(completeUploadSchema.safeParse({ sourceVideoId: id, rightsDeclaration }).success).toBe(true);
    expect(importUrlSchema.safeParse({ url: 'https://example.test/video.mp4', rightsDeclaration }).success).toBe(true);
  });
});
