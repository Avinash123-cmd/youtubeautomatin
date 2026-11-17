/**
 * Client-side YouTube helpers.
 *
 * The browser only needs to answer "is this worth asking the API about?" and to render a thumbnail
 * before the request returns. The API re-parses every URL with the same rules and is authoritative;
 * nothing here is a security boundary.
 */

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeId(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!HOSTS.has(url.hostname)) return null;
  let id: string | null = null;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    id = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
  }
  return id && ID.test(id) ? id : null;
}

export function youtubeThumbnail(videoId: string, quality: 'hq' | 'mq' | 'max' = 'hq'): string {
  const file = quality === 'max' ? 'maxresdefault' : quality === 'mq' ? 'mqdefault' : 'hqdefault';
  return `https://i.ytimg.com/vi/${videoId}/${file}.jpg`;
}

export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export interface YouTubeInspectResponse {
  videoId: string;
  availability: 'AVAILABLE' | 'UNAVAILABLE_OR_PRIVATE' | string;
  metadata: {
    snippet: { title: string; description: string; channelTitle: string };
    thumbnailUrl?: string;
    embedUrl?: string;
    durationSeconds?: number | null;
    canonicalUrl?: string;
    contentDetails?: { duration?: string };
  } | null;
  thumbnailUrl?: string;
  canonicalUrl?: string;
  originalMedia: string;
  transcript: string;
  message: string;
}

export interface YouTubeImportStatus {
  enabled: boolean;
  tool: { available: boolean; version: string | null; reason: string | null };
  maxHeight: number;
  maxFilesizeMb: number;
}
