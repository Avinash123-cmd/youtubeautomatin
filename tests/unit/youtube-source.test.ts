import 'reflect-metadata';
import { afterEach, expect, it, vi } from 'vitest';
import { parseYouTubeVideoId } from '@clipforge/validation';
vi.mock('../../apps/api/src/common/env', () => ({ env: { UPLOAD_PART_SIZE_MIB: 8, YOUTUBE_DATA_API_KEY: 'test-only-key' } }));
import { SourcesService } from '../../apps/api/src/sources/sources.service';
const service = new SourcesService({} as never, {} as never, {} as never);
const id = 'dQw4w9WgXcQ';
afterEach(() => vi.unstubAllGlobals());
it.each([`https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}&t=12`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/embed/${id}`, `https://youtube.com/live/${id}`])('parses official video reference %s', url => { expect(parseYouTubeVideoId(url)).toBe(id); });
it.each([`https://evil.test/watch?v=${id}`, `https://youtube.com.evil.test/watch?v=${id}`, `https://user@youtube.com/watch?v=${id}`, `http://youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=bad`, `https://youtu.be/${id}/extra`, `https://youtube.com/watch?v=${id}&v=aaaaaaaaaaa`])('rejects malformed or untrusted video reference %s', url => { expect(parseYouTubeVideoId(url)).toBeNull(); });
it('uses only the official metadata endpoint and never promises download or transcript access', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id, snippet: { title: 'Actual title', description: 'Actual description', channelTitle: 'Owner' }, contentDetails: { duration: 'PT3M', caption: 'true' } }] })));
  vi.stubGlobal('fetch', fetcher);
  const result = await service.inspectYouTube(`https://youtu.be/${id}`);
  expect(result.metadata?.snippet.title).toBe('Actual title');
  expect(result.originalMedia).toBe('UPLOAD_REQUIRED'); expect(result.transcript).toBe('NOT_RETRIEVED');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}`);
  expect(fetcher.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-only-key');
});
it('reports private/deleted/inaccessible video without claiming media availability', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"items":[]}')));
  expect((await service.inspectYouTube(`https://youtu.be/${id}`)).availability).toBe('UNAVAILABLE_OR_PRIVATE');
});
it('rejects invalid URLs before any network request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(service.inspectYouTube('https://evil.test/watch?v=anything')).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});
it('surfaces remote failures without logging credentials or provider response bodies', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive remote error', { status: 403 })));
  await expect(service.inspectYouTube(`https://youtu.be/${id}`)).rejects.toMatchObject({ response: { code: 'YOUTUBE_LOOKUP_FAILED' } });
});
