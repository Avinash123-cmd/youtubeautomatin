-- A pasted YouTube URL is now a first-class source kind. The value is added in its own
-- migration because PostgreSQL cannot use a new enum value inside the transaction that adds it.
ALTER TYPE "SourceKind" ADD VALUE IF NOT EXISTS 'YOUTUBE';
