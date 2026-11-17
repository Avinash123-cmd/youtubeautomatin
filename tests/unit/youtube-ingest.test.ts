import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeYouTubeUrl, parseYouTubeVideoId } from '@clipforge/validation';
import {
  buildYtDlpDownloadArgs,
  classifyYtDlpFailure,
  parseInfoJson,
  parseYtDlpProgressLine,
  resolveDownloadedFile,
  YoutubeIngestError,
} from '../../apps/api/src/sources/youtube/ytdlp';
import { buildPreview, oEmbedRequestUrl, parseIsoDuration, youtubeUrls } from '../../apps/api/src/sources/youtube/preview';
import { fileNameFor } from '../../apps/api/src/sources/youtube/youtube-import.service';

const ID = 'dQw4w9WgXcQ';

describe('YouTube URL normalization', () => {
  it.each([
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/shorts/${ID}`,
    `https://youtube.com/embed/${ID}`,
    `https://youtube.com/live/${ID}?feature=share`,
  ])('canonicalises %s without carrying query parameters forward', (url) => {
    const normalized = normalizeYouTubeUrl(url);
    expect(normalized).not.toBeNull();
    expect(normalized!.videoId).toBe(ID);
    // The canonical form is what a downloader receives: no playlist, timestamp or tracking data.
    expect(normalized!.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it.each([
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://www.youtube.com/playlist?list=PL123',
  ])('rejects %s', (url) => {
    expect(normalizeYouTubeUrl(url)).toBeNull();
    expect(parseYouTubeVideoId(url)).toBeNull();
  });
});

describe('yt-dlp argument construction', () => {
  const base = {
    url: `https://www.youtube.com/watch?v=${ID}`,
    outputTemplate: '/data/work/job/source.%(ext)s',
    maxHeight: 1080,
    maxFilesizeMb: 2048,
  };

  it('never expands a playlist and terminates options before the URL', () => {
    const args = buildYtDlpDownloadArgs(base);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--no-config-locations');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe(base.url);
    // Exactly one positional argument, always after `--`.
    expect(args.filter((arg) => arg.startsWith('https://'))).toHaveLength(1);
  });

  it('caps resolution and file size', () => {
    const args = buildYtDlpDownloadArgs(base);
    expect(args[args.indexOf('--max-filesize') + 1]).toBe('2048M');
    expect(args[args.indexOf('--format') + 1]).toContain('[height<=1080]');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
    expect(args).toContain('--write-info-json');
  });

  it('passes optional cookies, proxy and ffmpeg location as separate argv entries', () => {
    const args = buildYtDlpDownloadArgs({
      ...base,
      cookiesFile: '/run/secrets/cookies.txt',
      proxy: 'http://proxy.internal:8080',
      ffmpegLocation: '/usr/bin',
      retries: 99,
      socketTimeoutSeconds: 1,
    });
    expect(args[args.indexOf('--cookies') + 1]).toBe('/run/secrets/cookies.txt');
    expect(args[args.indexOf('--proxy') + 1]).toBe('http://proxy.internal:8080');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/usr/bin');
    // Values are clamped instead of trusted.
    expect(args[args.indexOf('--retries') + 1]).toBe('10');
    expect(args[args.indexOf('--socket-timeout') + 1]).toBe('5');
  });

  it('keeps a hostile URL as one positional argument, never as a flag', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&--exec=curl%20evil';
    const args = buildYtDlpDownloadArgs({ ...base, url });
    expect(args[args.length - 1]).toBe(url);
    expect(args.filter((arg) => arg.startsWith('--exec'))).toHaveLength(0);
  });

  it('collapses a boolean argument model — every option value is a discrete token', () => {
    const args = buildYtDlpDownloadArgs(base);
    expect(args.every((arg) => typeof arg === 'string' && !arg.includes('\n'))).toBe(true);
  });
});

describe('yt-dlp progress parsing', () => {
  it('reads a standard progress line', () => {
    const progress = parseYtDlpProgressLine('[download]  42.5% of 100.00MiB at 2.50MiB/s ETA 00:23');
    expect(progress).toMatchObject({ percent: 42.5, phase: 'downloading', speed: '2.50MiB/s', eta: '00:23' });
    expect(progress!.totalBytes).toBe(Math.round(100 * 1024 ** 2));
  });

  it('treats a merge line as completion of the download phase', () => {
    expect(parseYtDlpProgressLine('[Merger] Merging formats into "source.mp4"')).toMatchObject({ percent: 100, phase: 'merging' });
  });

  it('ignores unrelated output and clamps percentages', () => {
    expect(parseYtDlpProgressLine('[youtube] Extracting URL')).toBeNull();
    expect(parseYtDlpProgressLine('[download] 142.0% of 1.00MiB')).toMatchObject({ percent: 100 });
  });
});

describe('yt-dlp failure classification', () => {
  it.each([
    ['ERROR: [youtube] x: Video unavailable', 'YOUTUBE_SOURCE_UNAVAILABLE', false],
    ['ERROR: Private video. Sign in if you\'ve been granted access', 'YOUTUBE_SOURCE_PRIVATE', false],
    ['ERROR: Join this channel to get access to members-only content', 'YOUTUBE_SOURCE_PRIVATE', true],
    ['ERROR: HTTP Error 429: Too Many Requests', 'YOUTUBE_IMPORT_RATE_LIMITED', false],
    ['ERROR: Sign in to confirm you\'re not a bot', 'YOUTUBE_IMPORT_FORBIDDEN', true],
    ['ERROR: File is larger than max-filesize', 'YOUTUBE_SOURCE_TOO_LARGE', true],
    ['/bin/sh: yt-dlp: command not found', 'YOUTUBE_TOOL_UNAVAILABLE', true],
  ])('classifies "%s"', (output, code, needsConfiguration) => {
    const classified = classifyYtDlpFailure(output);
    expect(classified.code).toBe(code);
    expect(classified.needsConfiguration).toBe(needsConfiguration);
    expect(classified.message.length).toBeGreaterThan(10);
  });

  it('keeps unknown failures retryable', () => {
    const classified = classifyYtDlpFailure('ERROR: something unexpected happened');
    expect(classified.retryable).toBe(true);
    expect(classified.needsConfiguration).toBe(false);
  });

  it('exposes retry semantics through the error type', () => {
    const error = new YoutubeIngestError(classifyYtDlpFailure('ERROR: HTTP Error 429'));
    expect(error.retryable).toBe(true);
    expect(error.code).toBe('YOUTUBE_IMPORT_RATE_LIMITED');
    expect(error.needsConfiguration).toBe(false);
  });
});

describe('downloaded artefact resolution', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clipforge-ytdlp-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('prefers the merged mp4 and ignores partial/json sidecars', async () => {
    const template = join(directory, 'source.%(ext)s');
    await writeFile(join(directory, 'source.webm'), 'webm-bytes');
    await writeFile(join(directory, 'source.mp4'), 'mp4-bytes');
    await writeFile(join(directory, 'source.mp4.part'), 'partial');
    await writeFile(join(directory, 'source.info.json'), '{}');
    await expect(resolveDownloadedFile(template)).resolves.toBe(join(directory, 'source.mp4'));
  });

  it('returns null when nothing was written', async () => {
    await expect(resolveDownloadedFile(join(directory, 'missing.%(ext)s'))).resolves.toBeNull();
  });

  it('parses the info sidecar tolerantly', () => {
    const info = parseInfoJson({ title: 'Episode 12', uploader: 'Channel', duration: 1830.5, view_count: 42, is_live: false });
    expect(info).toMatchObject({ title: 'Episode 12', uploader: 'Channel', durationSeconds: 1830.5, viewCount: 42 });
    expect(parseInfoJson('not an object')).toBeNull();
  });
});

describe('preview helpers', () => {
  it('builds deterministic URLs from an id only', () => {
    expect(youtubeUrls(ID)).toMatchObject({
      canonicalUrl: `https://www.youtube.com/watch?v=${ID}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    });
    const request = new URL(oEmbedRequestUrl(`https://www.youtube.com/watch?v=${ID}`));
    expect(request.origin).toBe('https://www.youtube.com');
    expect(request.searchParams.get('url')).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('parses ISO-8601 durations', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P1DT1H')).toBe(90_000);
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration('not-a-duration')).toBeNull();
  });

  it('falls back to the deterministic thumbnail and keeps https-only author thumbnails', () => {
    const preview = buildPreview(ID, { title: 'Title', author_name: 'Author', thumbnail_url: 'http://insecure.test/x.jpg' });
    expect(preview.thumbnailUrl).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    expect(preview.author).toBe('Author');
  });
});

describe('source file naming', () => {
  it('sanitises titles and never emits a path', () => {
    expect(fileNameFor('../../etc/passwd', ID)).toBe('etcpasswd.mp4');
    expect(fileNameFor('A title: with / odd * characters?', ID)).toBe('A-title-with-odd-characters.mp4');
    expect(fileNameFor(null, ID)).toBe(`youtube-${ID}.mp4`);
    expect(fileNameFor('..', ID)).toBe(`youtube-${ID}.mp4`);
  });
});
