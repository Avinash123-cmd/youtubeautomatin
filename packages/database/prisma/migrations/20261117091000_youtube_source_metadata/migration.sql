-- Additive: resolved source metadata (oEmbed / yt-dlp info) and the ingest timestamp.
ALTER TABLE "SourceVideo" ADD COLUMN IF NOT EXISTS "sourceMetadata" JSONB;
ALTER TABLE "SourceVideo" ADD COLUMN IF NOT EXISTS "ingestedAt" TIMESTAMP(3);
