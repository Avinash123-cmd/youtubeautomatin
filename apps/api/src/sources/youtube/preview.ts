/**
 * YouTube preview metadata — the part of the pasted-URL flow that must be instant.
 *
 * oEmbed is used first because it needs no API key and answers in one request. The Data API is a
 * fallback/enrichment only when YOUTUBE_DATA_API_KEY is configured; nothing here downloads media.
 */
import { z } from 'zod';
import { normalizeYouTubeUrl } from '@clipforge/validation';

export const oEmbedSchema = z.object({
  title: z.string().min(1).max(500),
  author_name: z.string().max(200).optional(),
  author_url: z.string().max(2048).optional(),
  thumbnail_url: z.string().max(2048).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  provider_name: z.string().optional(),
});

export interface YouTubePreview {
  videoId: string;
  canonicalUrl: string;
  embedUrl: string;
  watchUrl: string;
  title: string;
  author: string | null;
  authorUrl: string | null;
  thumbnailUrl: string;
  durationSeconds: number | null;
  source: 'oembed' | 'data-api';
}

/** Deterministic URLs for a validated id — never string-concatenated from user input. */
export function youtubeUrls(videoId: string): { canonicalUrl: string; embedUrl: string; watchUrl: string; thumbnailUrl: string } {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    canonicalUrl,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    watchUrl: canonicalUrl,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

export function oEmbedRequestUrl(canonicalUrl: string): string {
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', canonicalUrl);
  url.searchParams.set('format', 'json');
  return url.toString();
}

export function buildPreview(videoId: string, payload: z.infer<typeof oEmbedSchema>): YouTubePreview {
  const urls = youtubeUrls(videoId);
  return {
    videoId,
    ...urls,
    title: payload.title,
    author: payload.author_name?.trim() || null,
    authorUrl: payload.author_url ?? null,
    thumbnailUrl: payload.thumbnail_url?.startsWith('https://') ? payload.thumbnail_url : urls.thumbnailUrl,
    durationSeconds: null,
    source: 'oembed',
  };
}

/** ISO-8601 duration (`PT1H2M3S`) from the Data API → seconds. */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Extracts a preview from raw user input, or null when the URL is not an allowed YouTube video. */
export function parseSourceUrl(input: string): { videoId: string; canonicalUrl: string } | null {
  const normalized = normalizeYouTubeUrl(input);
  if (!normalized) return null;
  return { videoId: normalized.videoId, canonicalUrl: normalized.canonicalUrl };
}
