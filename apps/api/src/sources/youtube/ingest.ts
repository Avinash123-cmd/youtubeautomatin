/**
 * The ingest step of the pipeline for URL-based sources.
 *
 * Kept separate from the Nest service so the worker can call it with an explicit service instance
 * (the worker runtime does not boot the HTTP module graph). Failure classification is preserved:
 * the caller decides between `RETRYING` and `NEEDS_CONFIGURATION` based on `needsConfiguration`.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { normalizeYouTubeUrl } from '@clipforge/validation';
import type { YoutubeImportService } from './youtube-import.service';
import type { SourceInfo } from './ytdlp';

export interface IngestSourceRecord {
  id: string;
  workspaceId: string;
  sourceUrl: string | null;
  youTubeReferenceUrl: string | null;
  youTubeReferenceId: string | null;
}

export interface IngestResult {
  path: string;
  sizeBytes: number;
  info: SourceInfo | null;
}

export async function ingestYouTubeSource(options: {
  source: IngestSourceRecord;
  /** Path without extension; yt-dlp appends the real container. */
  destinationBase: string;
  service: YoutubeImportService;
  onProgress?: (percent: number, detail: string) => void;
}): Promise<IngestResult> {
  const rawUrl = options.source.sourceUrl ?? options.source.youTubeReferenceUrl ?? options.source.youTubeReferenceId ?? '';
  const normalized = normalizeYouTubeUrl(
    options.source.youTubeReferenceId && !rawUrl.includes('watch') ? `https://youtu.be/${options.source.youTubeReferenceId}` : rawUrl,
  );
  if (!normalized) {
    throw new Error(`Source ${options.source.id} has no valid YouTube reference to ingest`);
  }

  await mkdir(dirname(options.destinationBase), { recursive: true });

  const download = await options.service.downloadToFile({
    videoId: normalized.videoId,
    canonicalUrl: normalized.canonicalUrl,
    destinationBase: options.destinationBase,
    onProgress: (progress) => {
      const detail =
        progress.phase === 'merging'
          ? 'Merging video and audio streams'
          : `Downloading from YouTube ${progress.percent.toFixed(0)}%${progress.speed ? ` · ${progress.speed}` : ''}`;
      options.onProgress?.(progress.percent, detail);
    },
  });

  const info = await stat(download.path);
  if (info.size <= 0) throw new Error('YouTube ingest produced an empty file');
  return { path: download.path, sizeBytes: info.size, info: download.info };
}
