/**
 * One shape for a source video in every API response.
 *
 * The upload flow, the direct-URL import and the YouTube ingest all return sources, so the mapping
 * lives here instead of being copied per service. Storage keys are never exposed: callers get a
 * media URL that is authorised per workspace.
 */
export interface SourceVideoRecord {
  id: string;
  kind: string;
  status: string;
  originalFileName: string | null;
  sizeBytes: bigint | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  youTubeReferenceUrl: string | null;
  sourceUrl: string | null;
  rejectionReason: string | null;
  storageKey: string | null;
  probeResult: unknown;
  createdAt: Date;
  sourceMetadata?: unknown;
  ingestedAt?: Date | null;
}

export interface SourceVideoDto {
  id: string;
  kind: string;
  status: string;
  originalFileName: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  youTubeReferenceUrl: string | null;
  sourceUrl: string | null;
  rejectionReason: string | null;
  mediaUrl: string | null;
  probe: unknown;
  metadata: unknown;
  ingestedAt: string | null;
  createdAt: string;
}

export function toSourceDto(source: SourceVideoRecord): SourceVideoDto {
  return {
    id: source.id,
    kind: source.kind,
    status: source.status,
    originalFileName: source.originalFileName,
    sizeBytes: source.sizeBytes ? Number(source.sizeBytes) : null,
    durationSeconds: source.durationSeconds,
    width: source.width,
    height: source.height,
    frameRate: source.frameRate,
    youTubeReferenceUrl: source.youTubeReferenceUrl,
    sourceUrl: source.sourceUrl,
    rejectionReason: source.rejectionReason,
    // Never expose the raw storage key; hand out a media URL when one exists.
    mediaUrl: source.storageKey ? `/media/sources/${source.id}` : null,
    probe: source.probeResult,
    metadata: source.sourceMetadata ?? null,
    ingestedAt: source.ingestedAt ? source.ingestedAt.toISOString() : null,
    createdAt: source.createdAt.toISOString(),
  };
}
