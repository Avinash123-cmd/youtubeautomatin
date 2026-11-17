/**
 * YouTube source import.
 *
 * The API only *records* the request and resolves preview metadata; the bytes are fetched by the
 * pipeline worker during PROBING (see `ingest.ts`). That split matters: a 90-minute download must
 * not hold an HTTP request open, and the worker already owns retries, leases and storage.
 */
import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFile, rm, stat } from 'node:fs/promises';
import { prisma, appendAuditLog } from '@clipforge/database';
import { normalizeYouTubeUrl } from '@clipforge/validation';
import { env } from '../../common/env';
import type { RequestContext } from '../../common/guards/session-auth.guard';
import { oEmbedSchema, buildPreview, oEmbedRequestUrl, parseIsoDuration, type YouTubePreview } from './preview';
import {
  buildYtDlpDownloadArgs,
  classifyYtDlpFailure,
  parseInfoJson,
  parseYtDlpProgressLine,
  resolveDownloadedFile,
  runYtDlp,
  YoutubeIngestError,
  type DownloadProgress,
  type SourceInfo,
} from './ytdlp';

export interface YoutubeToolStatus {
  available: boolean;
  version: string | null;
  reason: string | null;
}

export interface YoutubeImportStatus {
  enabled: boolean;
  tool: YoutubeToolStatus;
  maxHeight: number;
  maxFilesizeMb: number;
}

export interface YoutubePreviewResult extends YouTubePreview {
  available: boolean;
}

export interface YoutubeDownloadResult {
  path: string;
  sizeBytes: number;
  info: SourceInfo | null;
}

const TOOL_STATUS_TTL_MS = 60_000;

@Injectable()
export class YoutubeImportService {
  private readonly logger = new Logger(YoutubeImportService.name);
  private toolStatus: { value: YoutubeToolStatus; expiresAt: number } | null = null;

  /** One `yt-dlp --version` per minute, not per request. */
  async probeTool(): Promise<YoutubeToolStatus> {
    const now = Date.now();
    if (this.toolStatus && this.toolStatus.expiresAt > now) return this.toolStatus.value;
    let value: YoutubeToolStatus;
    try {
      const result = await runYtDlp({ binary: env.YTDLP_PATH, args: ['--version'], timeoutSeconds: 10 });
      const version = result.stdout.trim().split('\n').filter(Boolean)[0] ?? null;
      value = result.exitCode === 0 && version
        ? { available: true, version, reason: null }
        : { available: false, version: null, reason: 'yt-dlp exited non-zero (see API logs)' };
    } catch (error) {
      const classified = error instanceof YoutubeIngestError ? error.classified : null;
      value = {
        available: false,
        version: null,
        reason: classified?.message ?? `yt-dlp could not be started from "${env.YTDLP_PATH}"`,
      };
    }
    this.toolStatus = { value, expiresAt: now + TOOL_STATUS_TTL_MS };
    return value;
  }

  async status(): Promise<YoutubeImportStatus> {
    const tool = env.YOUTUBE_IMPORT_ENABLED
      ? await this.probeTool()
      : { available: false, version: null, reason: 'disabled by configuration' };
    return {
      enabled: env.YOUTUBE_IMPORT_ENABLED,
      tool,
      maxHeight: env.YOUTUBE_IMPORT_MAX_HEIGHT,
      maxFilesizeMb: env.YOUTUBE_IMPORT_MAX_FILESIZE_MB,
    };
  }

  /**
   * Resolves title/author/thumbnail for a pasted URL through oEmbed, then enriches duration from the
   * Data API when a key is configured (oEmbed has no duration field).
   */
  async preview(url: string): Promise<YoutubePreviewResult> {
    const normalized = normalizeYouTubeUrl(url);
    if (!normalized) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Provide a valid https:// YouTube video URL' });
    }

    let response: Response;
    try {
      response = await fetch(oEmbedRequestUrl(normalized.canonicalUrl), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'YOUTUBE_LOOKUP_FAILED',
        message: `YouTube preview could not be resolved: ${(error as Error).message}`,
      });
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ...buildPreview(normalized.videoId, { title: 'Unavailable video' }), title: '', available: false, durationSeconds: null };
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({ code: 'YOUTUBE_LOOKUP_FAILED', message: `YouTube oEmbed returned HTTP ${response.status}` });
    }

    let preview: YouTubePreview;
    try {
      preview = buildPreview(normalized.videoId, oEmbedSchema.parse(await response.json()));
    } catch {
      throw new ServiceUnavailableException({ code: 'INVALID_PROVIDER_RESPONSE', message: 'YouTube returned an unreadable preview' });
    }

    let durationSeconds: number | null = null;
    if (env.YOUTUBE_DATA_API_KEY) {
      try {
        const lookup = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(normalized.videoId)}`,
          { headers: { 'x-goog-api-key': env.YOUTUBE_DATA_API_KEY }, signal: AbortSignal.timeout(6000), redirect: 'error' },
        );
        if (lookup.ok) {
          const payload = (await lookup.json()) as { items?: Array<{ contentDetails?: { duration?: string } }> };
          durationSeconds = parseIsoDuration(payload.items?.[0]?.contentDetails?.duration ?? null);
        }
      } catch {
        // Duration is a nicety; the worker probes the real file anyway.
      }
    }
    return { ...preview, durationSeconds, available: true };
  }

  /**
   * Creates the source row for a pasted URL. Nothing is downloaded here; the job that references it
   * triggers the ingest step. The rights declaration is mandatory and audited, exactly as for an
   * upload.
   */
  async createSource(input: { url: string; rightsDeclaration: { accepted: true; statement: string } }, ctx: RequestContext) {
    if (!env.YOUTUBE_IMPORT_ENABLED) {
      throw new ServiceUnavailableException({
        code: 'CONFIGURATION_REQUIRED',
        message: 'YouTube import is disabled for this deployment. Set YOUTUBE_IMPORT_ENABLED=true or upload the original file.',
        details: { missingConfiguration: ['YOUTUBE_IMPORT_ENABLED'] },
      });
    }
    const normalized = normalizeYouTubeUrl(input.url);
    if (!normalized) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Provide a valid https:// YouTube video URL' });
    }
    const tool = await this.probeTool();
    if (!tool.available) {
      throw new ServiceUnavailableException({
        code: 'CONFIGURATION_REQUIRED',
        message: `YouTube import needs yt-dlp on the API host: ${tool.reason ?? 'yt-dlp is unavailable'}. Install it with "pip install yt-dlp" or set YTDLP_PATH.`,
        details: { missingConfiguration: ['YTDLP_PATH'] },
      });
    }

    const preview = await this.preview(normalized.canonicalUrl);
    if (!preview.available) {
      throw new NotFoundException({
        code: 'YOUTUBE_UNAVAILABLE',
        message: 'YouTube reports this video as unavailable, private or removed. Choose another URL or upload the original file.',
      });
    }

    const source = await prisma.sourceVideo.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        kind: 'YOUTUBE',
        status: 'INITIATED',
        originalFileName: fileNameFor(preview.title, normalized.videoId),
        sourceUrl: normalized.canonicalUrl,
        youTubeReferenceUrl: normalized.canonicalUrl,
        youTubeReferenceId: normalized.videoId,
        durationSeconds: preview.durationSeconds ?? null,
        sourceMetadata: {
          videoId: normalized.videoId,
          title: preview.title,
          author: preview.author,
          thumbnailUrl: preview.thumbnailUrl,
          embedUrl: preview.embedUrl,
          previewSource: preview.source,
          requestedUrl: input.url,
          importRequestedAt: new Date().toISOString(),
        },
        rightsDeclaration: {
          accepted: true,
          acceptedAt: new Date().toISOString(),
          acceptedByUserId: ctx.userId,
          statement: input.rightsDeclaration.statement,
        },
      },
    });

    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'RIGHTS_DECLARED',
      targetType: 'SourceVideo',
      targetId: source.id,
      summary: `Rights declaration accepted for YouTube source ${normalized.videoId}`,
      metadata: { statement: input.rightsDeclaration.statement, videoId: normalized.videoId },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    }).catch((error) => this.logger.warn(`audit write failed for youtube source ${source.id}: ${(error as Error).message}`));

    return source;
  }

  /**
   * Downloads the original media to `<destinationBase>.<ext>`. Called from the pipeline worker; a
   * failure carries a classified code so the worker can decide between retry and configuration.
   */
  async downloadToFile(options: {
    videoId: string;
    canonicalUrl: string;
    destinationBase: string;
    onProgress?: (progress: DownloadProgress) => void;
  }): Promise<YoutubeDownloadResult> {
    if (!env.YOUTUBE_IMPORT_ENABLED) {
      throw new YoutubeIngestError({
        code: 'YOUTUBE_TOOL_UNAVAILABLE',
        message: 'YouTube import is disabled (YOUTUBE_IMPORT_ENABLED=false).',
        retryable: false,
        needsConfiguration: true,
      });
    }
    const outputTemplate = `${options.destinationBase}.%(ext)s`;
    const args = buildYtDlpDownloadArgs({
      url: options.canonicalUrl,
      outputTemplate,
      maxHeight: env.YOUTUBE_IMPORT_MAX_HEIGHT,
      maxFilesizeMb: env.YOUTUBE_IMPORT_MAX_FILESIZE_MB,
      cookiesFile: env.YOUTUBE_COOKIES_FILE,
      proxy: env.YOUTUBE_PROXY,
      ffmpegLocation: env.YOUTUBE_YTDLP_FFMPEG_LOCATION,
    });

    const result = await runYtDlp({
      binary: env.YTDLP_PATH,
      args,
      timeoutSeconds: env.YOUTUBE_IMPORT_TIMEOUT_SECONDS,
      onLine: (line) => {
        const progress = parseYtDlpProgressLine(line);
        if (progress) options.onProgress?.(progress);
      },
    });

    if (result.timedOut) {
      throw new YoutubeIngestError({
        code: 'YOUTUBE_IMPORT_TIMEOUT',
        message: `Downloading the source exceeded ${env.YOUTUBE_IMPORT_TIMEOUT_SECONDS}s (YOUTUBE_IMPORT_TIMEOUT_SECONDS).`,
        retryable: true,
        needsConfiguration: false,
      });
    }
    if (result.exitCode !== 0) {
      throw new YoutubeIngestError(classifyYtDlpFailure(`${result.stderr}\n${result.stdout}`));
    }

    const path = await resolveDownloadedFile(outputTemplate);
    if (!path) {
      throw new YoutubeIngestError(
        classifyYtDlpFailure(`${result.stderr}\n${result.stdout}`, 'yt-dlp reported success but produced no media file'),
      );
    }
    const info = await stat(path);
    if (info.size > env.YOUTUBE_IMPORT_MAX_FILESIZE_MB * 1024 * 1024 * 1.05) {
      await rm(path, { force: true });
      throw new YoutubeIngestError({
        code: 'YOUTUBE_SOURCE_TOO_LARGE',
        message: `The downloaded file is ${(info.size / 1024 / 1024).toFixed(1)} MB, above YOUTUBE_IMPORT_MAX_FILESIZE_MB.`,
        retryable: false,
        needsConfiguration: true,
      });
    }

    const infoJsonPath = `${options.destinationBase}.info.json`;
    let sourceInfo: SourceInfo | null = null;
    try {
      sourceInfo = parseInfoJson(JSON.parse(await readFile(infoJsonPath, 'utf8')));
      await rm(infoJsonPath, { force: true });
    } catch {
      sourceInfo = null;
    }

    return { path, sizeBytes: info.size, info: sourceInfo };
  }
}

/** Filesystem-safe name derived from the video title; never used as a path on its own. */
export function fileNameFor(title: string | null, videoId: string): string {
  const base = (title ?? '')
    .normalize('NFKC')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base.length > 2 ? base : `youtube-${videoId}`}.mp4`;
}
