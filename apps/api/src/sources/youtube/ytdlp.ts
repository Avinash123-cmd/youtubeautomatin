/**
 * yt-dlp integration — pure helpers plus one carefully bounded process runner.
 *
 * Everything that decides *what* is executed lives in this file and is unit-tested without the
 * binary: argument construction, progress parsing, failure classification and output resolution.
 * The runner never uses a shell, always passes the URL after `--`, always kills the process tree on
 * timeout and never logs a cookie value.
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface YtDlpDownloadOptions {
  /** Canonical watch URL produced by `normalizeYouTubeUrl` (never raw user input). */
  url: string;
  /** Absolute output template, e.g. `/data/work/<job>/source.%(ext)s`. */
  outputTemplate: string;
  maxHeight: number;
  maxFilesizeMb: number;
  cookiesFile?: string;
  proxy?: string;
  ffmpegLocation?: string;
  retries?: number;
  socketTimeoutSeconds?: number;
}

export interface DownloadProgress {
  /** 0-100, rounded to one decimal. */
  percent: number;
  totalBytes: number | null;
  speed: string | null;
  eta: string | null;
  phase: 'downloading' | 'merging' | 'postprocessing';
}

/**
 * The exact argv handed to yt-dlp for a source import.
 *
 * Security-relevant decisions, each deliberate:
 *  - `--no-playlist` — a URL that carries `list=` must never expand into an unbounded download.
 *  - `--` — everything after it is positional, so a crafted URL can never become a flag.
 *  - resolution and container caps keep the renderer's 9:16 crop honest and the disk bounded.
 *  - `--no-cache-dir`/`--no-config-locations` keep behaviour identical across hosts.
 */
export function buildYtDlpDownloadArgs(options: YtDlpDownloadOptions): string[] {
  const retries = String(Math.max(0, Math.min(10, options.retries ?? 3)));
  const socketTimeout = String(Math.max(5, Math.min(120, options.socketTimeoutSeconds ?? 30)));
  const args = [
    '--no-playlist',
    '--no-config-locations',
    '--no-cache-dir',
    '--newline',
    '--no-color',
    '--no-warnings',
    '--socket-timeout',
    socketTimeout,
    '--retries',
    retries,
    '--fragment-retries',
    retries,
    '--max-filesize',
    `${Math.max(16, Math.round(options.maxFilesizeMb))}M`,
    '--format',
    [
      `bv*[height<=${options.maxHeight}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${options.maxHeight}]+ba`,
      `b[height<=${options.maxHeight}]`,
      'b',
    ].join('/'),
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '--output',
    options.outputTemplate,
  ];
  if (options.cookiesFile) args.push('--cookies', options.cookiesFile);
  if (options.proxy) args.push('--proxy', options.proxy);
  if (options.ffmpegLocation) args.push('--ffmpeg-location', options.ffmpegLocation);
  args.push('--', options.url);
  return args;
}

const DOWNLOAD_LINE = /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+)([KMGTP]i?B))?(?:.*?at\s+([\d.]+[KMGTP]?i?B\/s))?(?:.*?ETA\s+([\d:]+))?/i;
const MERGE_LINE = /^\[(Merger|FixupM3u8|FixupM4a|VideoConvertor|VideoRemuxer)\]/i;

const UNIT_TO_BYTES: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** `[download]  12.3% of 100.00MiB at 2.00MiB/s ETA 00:30` → structured progress. */
export function parseYtDlpProgressLine(line: string): DownloadProgress | null {
  const trimmed = line.trim();
  if (MERGE_LINE.test(trimmed)) {
    return { percent: 100, totalBytes: null, speed: null, eta: null, phase: 'merging' };
  }
  const match = trimmed.match(DOWNLOAD_LINE);
  if (!match) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return null;
  let totalBytes: number | null = null;
  if (match[2] && match[3]) {
    const multiplier = UNIT_TO_BYTES[match[3].toUpperCase()];
    const value = Number(match[2]);
    if (multiplier && Number.isFinite(value)) totalBytes = Math.round(value * multiplier);
  }
  return {
    percent: Math.max(0, Math.min(100, percent)),
    totalBytes,
    speed: match[4] ?? null,
    eta: match[5] ?? null,
    phase: 'downloading',
  };
}

export type IngestFailureCode =
  | 'YOUTUBE_TOOL_UNAVAILABLE'
  | 'YOUTUBE_SOURCE_UNAVAILABLE'
  | 'YOUTUBE_SOURCE_PRIVATE'
  | 'YOUTUBE_SOURCE_TOO_LARGE'
  | 'YOUTUBE_IMPORT_RATE_LIMITED'
  | 'YOUTUBE_IMPORT_FORBIDDEN'
  | 'YOUTUBE_IMPORT_TIMEOUT'
  | 'YOUTUBE_IMPORT_FAILED';

export interface ClassifiedFailure {
  code: IngestFailureCode;
  message: string;
  retryable: boolean;
  needsConfiguration: boolean;
}

/**
 * Turns yt-dlp's stderr into a fact the operator can act on. A private video is not a transient
 * outage, and a missing binary is not something a retry can fix — both end the job definitively
 * instead of burning the retry budget.
 */
export function classifyYtDlpFailure(output: string, fallbackMessage = 'yt-dlp could not download the source video'): ClassifiedFailure {
  const text = output.toLowerCase();
  const firstLine = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('[download]') && !line.startsWith('WARNING'))
    .slice(-1)[0];

  const detail = firstLine ? firstLine.replace(/\s+/g, ' ').slice(0, 400) : fallbackMessage;

  if (text.includes('enoent') || text.includes('command not found') || text.includes('is not recognized as an internal')) {
    return {
      code: 'YOUTUBE_TOOL_UNAVAILABLE',
      message: 'yt-dlp is not installed on the API host. Install it (pip install yt-dlp) or set YTDLP_PATH.',
      retryable: false,
      needsConfiguration: true,
    };
  }
  if (text.includes('max-filesize') || text.includes('file is larger than max-filesize')) {
    return {
      code: 'YOUTUBE_SOURCE_TOO_LARGE',
      message: `The source exceeds YOUTUBE_IMPORT_MAX_FILESIZE_MB. Raise the limit or process a shorter video. (${detail})`,
      retryable: false,
      needsConfiguration: true,
    };
  }
  if (text.includes('private video') || text.includes('members-only') || text.includes('join this channel')) {
    return {
      code: 'YOUTUBE_SOURCE_PRIVATE',
      message: 'The video is private or members-only and cannot be ingested with the configured credentials.',
      retryable: false,
      needsConfiguration: text.includes('members-only') || text.includes('join this channel'),
    };
  }
  if (text.includes('video unavailable') || text.includes('this video is not available') || text.includes('has been removed') || text.includes('does not exist')) {
    return { code: 'YOUTUBE_SOURCE_UNAVAILABLE', message: 'YouTube reports the video as unavailable or removed.', retryable: false, needsConfiguration: false };
  }
  if (text.includes('429') || text.includes('too many requests')) {
    return { code: 'YOUTUBE_IMPORT_RATE_LIMITED', message: 'YouTube rate-limited the download. It will be retried with backoff.', retryable: true, needsConfiguration: false };
  }
  if (text.includes('sign in to confirm') || text.includes('not a bot') || text.includes('confirm you')) {
    return {
      code: 'YOUTUBE_IMPORT_FORBIDDEN',
      message: 'YouTube asked for a signed-in session. Provide YOUTUBE_COOKIES_FILE or use an authorized source upload.',
      retryable: false,
      needsConfiguration: true,
    };
  }
  if (text.includes('403') || text.includes('forbidden')) {
    return {
      code: 'YOUTUBE_IMPORT_FORBIDDEN',
      message: 'YouTube refused the download (HTTP 403). A cookies file or a newer yt-dlp release is usually required.',
      retryable: false,
      needsConfiguration: true,
    };
  }
  if (text.includes('unsupported url')) {
    return { code: 'YOUTUBE_SOURCE_UNAVAILABLE', message: 'yt-dlp does not support this URL.', retryable: false, needsConfiguration: false };
  }
  return { code: 'YOUTUBE_IMPORT_FAILED', message: detail, retryable: true, needsConfiguration: false };
}

export class YoutubeIngestError extends Error {
  constructor(readonly classified: ClassifiedFailure) {
    super(classified.message);
    this.name = 'YoutubeIngestError';
  }

  get retryable(): boolean {
    return this.classified.retryable;
  }

  get needsConfiguration(): boolean {
    return this.classified.needsConfiguration;
  }

  get code(): string {
    return this.classified.code;
  }
}

export interface RunYtDlpOptions {
  binary: string;
  args: string[];
  timeoutSeconds: number;
  onLine?: (line: string) => void;
  /** Environment additions; cookies are never placed here (they live in a file). */
  env?: NodeJS.ProcessEnv;
}

export interface RunYtDlpResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURED_OUTPUT = 32_000;

/** Runs yt-dlp without a shell, with a hard timeout and bounded output capture. */
export async function runYtDlp(options: RunYtDlpOptions): Promise<RunYtDlpResult> {
  return await new Promise<RunYtDlpResult>((resolve, reject) => {
    const pgroup = process.platform !== 'win32';
    const child = spawn(options.binary, options.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      shell: false,
      // A new process group lets the timeout kill yt-dlp *and* the ffmpeg it spawns for merging;
      // otherwise a killed parent leaves the muxer writing to disk.
      detached: pgroup,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let lineBuffer = '';

    const killTree = () => {
      try {
        if (pgroup && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, Math.max(10, options.timeoutSeconds) * 1000);

    /**
     * yt-dlp writes progress with \r on a terminal and \n with --newline; a chunk can still split a
     * line, so progress lines are assembled here instead of being parsed per chunk.
     */
    const appendChunk = (chunk: string, sink: 'out' | 'err') => {
      if (sink === 'out') stdout = (stdout + chunk).slice(-MAX_CAPTURED_OUTPUT);
      else stderr = (stderr + chunk).slice(-MAX_CAPTURED_OUTPUT);
      if (!options.onLine) return;
      lineBuffer += chunk.replace(/\r/g, '\n');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) options.onLine(line);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => appendChunk(chunk, 'out'));
    child.stderr?.on('data', (chunk: string) => appendChunk(chunk, 'err'));

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new YoutubeIngestError({
            code: 'YOUTUBE_TOOL_UNAVAILABLE',
            message: `yt-dlp was not found at "${options.binary}". Install it (pip install yt-dlp) or set YTDLP_PATH.`,
            retryable: false,
            needsConfiguration: true,
          }),
        );
        return;
      }
      reject(error);
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];

/**
 * Resolves the artifact yt-dlp actually wrote next to the requested template.
 * `--merge-output-format mp4` normally yields `<stem>.mp4`, but a source that is already a single
 * stream can stay in another container, so the directory is inspected instead of assumed.
 */
export async function resolveDownloadedFile(outputTemplate: string): Promise<string | null> {
  const directory = dirname(outputTemplate);
  const stem = basename(outputTemplate).replace(/%\(ext\)s$/, '').replace(/\.[A-Za-z0-9]+$/, '');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  const candidates: Array<{ path: string; size: number; score: number }> = [];
  for (const entry of entries) {
    if (entry.endsWith('.part') || entry.endsWith('.json') || entry.endsWith('.ytdl')) continue;
    if (!entry.startsWith(stem)) continue;
    const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(extension)) continue;
    const path = join(directory, entry);
    const info = await stat(path).catch(() => null);
    if (!info || info.size === 0) continue;
    candidates.push({ path, size: info.size, score: extension === '.mp4' ? 2 : 1 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.size - a.size);
  return candidates[0].path;
}

export interface SourceInfo {
  title: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  description: string | null;
  thumbnailUrl: string | null;
  webpageUrl: string | null;
  uploadDate: string | null;
  isLive: boolean;
  extractor: string | null;
}

/** Reads yt-dlp's `--write-info-json` sidecar, tolerating older/newer field sets. */
export function parseInfoJson(payload: unknown): SourceInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const text = (value: unknown, max = 5000): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    title: text(record.title, 500),
    uploader: text(record.uploader ?? record.channel, 200),
    durationSeconds: number(record.duration),
    viewCount: number(record.view_count),
    description: text(record.description, 20000),
    thumbnailUrl: text(record.thumbnail, 2048),
    webpageUrl: text(record.webpage_url, 2048),
    uploadDate: text(record.upload_date, 20),
    isLive: record.is_live === true || record.live_status === 'is_live',
    extractor: text(record.extractor, 100),
  };
}
