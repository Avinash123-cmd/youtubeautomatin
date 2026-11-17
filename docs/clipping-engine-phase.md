# Clipping-engine implementation and evidence

Date: 2026-11-16. Branch: `arena/e5780213-youtubeautomatin`. Inspected local and GitHub main base: `a234f75fc53697876147203fa4cc515dd39aaaca` (PR14 merged). Existing transactional state/lease/outbox repairs are retained.

## Architecture and implemented changes

Reused NestJS sources/jobs/clips, Prisma/PostgreSQL models, BullMQ pipeline/render workers, private S3/local storage, FastAPI AI/video services, faster-whisper, Gemini, and existing Next.js upload/preview/editor/download interfaces. No new service, production mock, dependency upgrade, authentication provider or downloader introduced.

1. **Source inspection:** strict HTTPS YouTube host/path/11-character video-ID parsing shared by reference validation and metadata lookup. Rejects credential-bearing, foreign-host, malformed and ambiguous watch URLs. Authenticated, rate-limited official YouTube Data API metadata lookup uses a server-only key, 10-second timeout, fixed endpoint, no redirects, validated response, and sanitized failures. Public metadata availability is NOT download permission. UI explicitly requests original upload/authorized direct media import. Captions are not scraped.
2. **AI integrity:** validate finite, positive, chronological segment/word timing against media duration for both actual ASR output and reused transcripts. Retain exact timestamps and any speaker labels; never synthesize timing. Validate Gemini output against the schema subset actually used by selection, captions and vision (objects, arrays, scalar types, required fields, enums, finite numbers). API key moves from URL query to request header. Invalid numeric scores reject candidates instead of crashing or silently producing inflated quality. Silent gaps and partial wordless segments no longer inherit entire unrelated transcript segments. Vision-disabled analysis now produces valid zero vision usage and honest empty results.
3. **Media analysis:** scene detection now propagates FFmpeg failure instead of silently reporting no scenes. A real test exposed removal of `-vsync` in the sandbox's current FFmpeg; changed to supported `-fps_mode vfr` (requires FFmpeg 5+). Existing actual vertical H.264/AAC rendering, framing, subtitle burning, loudness, thumbnails and output validation are reused, not replaced.
4. **Caption provenance:** additive nullable `ClipMetadata.originalAiOutput` JSONB and `editedAt` timestamp. Worker stores each platform's generated metadata object before user field edits; edits leave that object untouched. Clip detail returns provenance. Historical original output is intentionally NULL because edits cannot honestly be reversed. This stores the generated platform payload returned by the caption service, not a raw provider HTTP response or complete edit history. Application write paths preserve originals; this is not a database immutability trigger.
5. **Processing UI:** owned paginated analysis endpoint returns actual persisted transcript segments and scored candidates. Job page shows source timings, ASR provider/model, candidate hook/reason/category/quality, source speech, empty/error states, bounded pagination and polling for active jobs. Existing clip screens retain actual video preview, metadata editing and downloads.

## API contracts

New (existing global session/CSRF guards apply; Telegram-only auth unchanged):
- `POST /api/sources/youtube/inspect` body `{ "url": "https://www.youtube.com/watch?v=<11-character-id>" }`. Returns `videoId`, `availability`, validated official `metadata` or null, `originalMedia: UPLOAD_REQUIRED`, `transcript: NOT_RETRIEVED`, and an explanation. Missing key returns 503 CONFIGURATION_REQUIRED; private/deleted/unavailable items never become downloadable sources.
- `GET /api/jobs/:id/analysis?page=1&pageSize=50`: existing pagination schema, 100-row limit. Workspace ownership checked before transcript/candidate reads. Returns transcript provider metadata, segments/segmentCount, candidates/candidateCount and pagination. No fabricated text while processing.

Extended:
- `GET /api/clips/:id`: `captionProvenance` per platform with generated object and generated/edited timestamps.
- Existing metadata edit route records `editedAt` while keeping generated object.

Reused routes include `/api/sources/upload/{initiate,part,complete}`, `/api/sources/import`, `/api/jobs`, job status/events/cancel/retry, clip list/detail/metadata/download, and private `/media` delivery. Public API never exposes Python service keys.

## Configuration and deployment

New optional API variable: `YOUTUBE_DATA_API_KEY` (enable YouTube Data API v3 in the owning Google Cloud project; restrict the key). Absence blocks only metadata lookup, not original uploads. No live key supplied or tested here.

Existing AI service requirements: `AI_ENGINE_API_KEY`, `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `WHISPER_MODEL`, `WORK_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`. Optional compute settings: `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`; resource/time settings in the service README/config remain. faster-whisper runs locally and needs a cached model or permitted access to model downloads; it does not require a paid speech API key. No diarization engine is added: default speaker label remains null, not guessed.

API/worker setup also needs existing `AI_ENGINE_URL`, `AI_ENGINE_API_KEY`, `VIDEO_PROCESSOR_URL`, `VIDEO_PROCESSOR_API_KEY`, `DATABASE_URL`, `REDIS_URL`, encryption/session secrets and configured durable storage. Explicit model settings are `GEMINI_TEXT_MODEL`/`GEMINI_VISION_MODEL` and/or saved configuration (`ai.text_model`/`ai.vision_model`); the configured model is passed to the service, not silently chosen. See `.env.example` and service READMEs for all existing environment variables.

Apply the additive migration with normal Prisma native engines and authorized DB access **before running the new API/workers**:

```sh
npm ci
npm run db:deploy
npm run build
npm run start:api
```

Run Python services and workers using existing documented process commands. No migrations or deployments were executed by this phase. No production DB resets or data deletion. `WORK_DIR` must actually refer to shared processing media across the API/workers and Python services; permanent S3 storage does NOT automatically make path-based RPC inputs available in separate service filesystems. A co-located/shared-volume deployment or further media-transfer implementation remains necessary. Do not claim a split Render-service deployment works without it.

## Actual checks

- `npm ci`: passed, no project dependency changes.
- Complete `npm run build`: passed (packages, NestJS API, Next.js production build). Prisma generation used sandbox-only `PRISMA_GENERATE_NO_ENGINE=1` and `/bin/true` engine overrides due engine download restrictions. **Not production settings and not native DB runtime proof.**
- Vitest: **462 passed, 3 skipped, 65 files**. Test-only SESSION_SECRET supplied; startup artifact built first. Includes source parsing/provider contract, analysis ownership/pagination, caption edit provenance and isolated React render tests. Mocked external/DB tests are not live provider or database integration proof.
- Python: **44 passed, 0 skipped**, using test-only FFmpeg/FFprobe executables outside the repository. Includes actual MP4 generation/probe, mono 16kHz WAV extraction, scene scan, actual HTTP vertical render with timed burned subtitles/codecs/output validation, timing validation, schema checks, selection and disabled-vision regression. Synthetic sine/video fixtures test media processing, NOT speech-recognition accuracy or semantic quality.
- `npm run lint`: passed.
- `prisma validate`: passed using sandbox engine overrides and a nonconnecting test DSN; no DB connection/migration attempted.
- `git diff --check`: passed.

One real-test iteration initially failed: current FFmpeg rejected obsolete `-vsync`; fixed and reran successfully. Initial tool fixture lacked ffprobe executable permission; corrected external test tool permission, not application security settings.

## Acceptance limits / incomplete work

This is substantive implementation, **not certification that all 15 end-to-end acceptance criteria are met**.

- Live Gemini requests, real Whisper model inference/word alignment accuracy, official YouTube metadata requests, DB migration execution, authenticated browser E2E, real Redis/BullMQ delivery and production S3 workflow were not run: credentials/services/model availability are absent. Existing mocks are isolated tests only.
- Official owner-authorized YouTube caption retrieval is not implemented in this checkpoint. API clearly returns NOT_RETRIEVED; uploaded original speech uses faster-whisper. YouTube does not grant original media through a watch URL.
- Clip duration configuration remains the existing 15/30-second variants. Arbitrary duration settings are not implemented.
- Word boundaries/source timing are validated; semantic sentence completeness and truthfulness still require real provider/media acceptance and human review. Scores are editorial rubrics, not virality predictions. Schema validation cannot prove factuality.
- Durable private storage/upload/progress, duplicates, cleanup, lease fencing, retries, rendering/previews/editor/downloads remain existing implementations. This phase does not claim every one was newly end-to-end tested.
- Caption provenance is exposed by clip detail API; no original-vs-edited comparison UI or version history added.
- Existing broad release/deployment blockers in foundation/recovery documentation still apply. No platform publishing performed.

## Logical commits

- `e4b952b`: AI timing/provider/selection validation and media regressions.
- `383c0d1`: official metadata source inspection, strict parsing and create UI.
- `299f981`: additive caption provenance and edit regression.
- `2060c40`: owned analysis API and transcript/candidate processing UI.

## File manifest
.env.example
apps/api/src/clips/clips.service.ts
apps/api/src/common/env.ts
apps/api/src/jobs/jobs.controller.ts
apps/api/src/jobs/jobs.service.ts
apps/api/src/sources/sources.controller.ts
apps/api/src/sources/sources.service.ts
apps/api/src/workers/pipeline.worker.ts
apps/web/app/create/page.tsx
apps/web/app/jobs/[id]/page.tsx
apps/web/components/job-analysis.tsx
packages/database/prisma/migrations/20261116160000_caption_provenance/migration.sql
packages/database/prisma/schema.prisma
packages/validation/src/domain.ts
packages/validation/src/index.ts
services/ai-engine/app/gemini.py
services/ai-engine/app/media.py
services/ai-engine/app/pipeline.py
services/ai-engine/app/selection.py
services/ai-engine/app/timing.py
services/ai-engine/app/transcribe.py
tests/python/test_analysis_integrity.py
tests/unit/caption-provenance.test.ts
tests/unit/job-analysis-render.test.ts
tests/unit/job-analysis.test.ts
tests/unit/youtube-source.test.ts
