-- Additive only. Historical originals cannot be reconstructed honestly after edits.
ALTER TABLE "ClipMetadata" ADD COLUMN "originalAiOutput" JSONB;
ALTER TABLE "ClipMetadata" ADD COLUMN "editedAt" TIMESTAMP(3);
