# ClipForge AI

Turn one long video into captioned vertical clips and publish them to **YouTube Shorts** and
**Instagram Reels** — from a pasted YouTube link, an upload, or an authorised direct media URL.

ClipForge is a real pipeline, not a demo: media is downloaded and probed with FFmpeg, speech is
transcribed with Faster-Whisper, moments are scored by an LLM (Gemini) against a documented rubric,
clips are rendered to 1080×1920 with burned-in word-level captions, and publishing uses the official
YouTube Data API v3 and Instagram Graph API with OAuth, idempotency keys and full audit history.

Where a third-party credential is missing, the integration still exists and says so: the affected
operation returns `428 CONFIGURATION_REQUIRED` with the exact variable names, instead of pretending
to work. There are no mocked endpoints, seeded analytics or simulated uploads.

---

## The flow

```
Paste a YouTube URL ─┐
Upload a file ───────┼─▶ Source video ─▶ FFprobe validation
Direct media URL ────┘                      │
                                            ▼
                          Faster-Whisper transcription (word timestamps)
                                            │
                                            ▼
                 Gemini highlight analysis → scored candidates → duplicate
                 suppression → 15 s / 30 s clip plan (emergent count)
                                            │
                                            ▼
              FFmpeg render: 9:16 framing, burned-in captions, branding,
              −14 LUFS loudness, H.264/AAC → validated artefact in storage
                                            │
                                            ▼
              AI captions + hashtags per platform → review → publish
              (manual, scheduled, or automatic when the job asks for it)
```

A pasted YouTube link is fetched by **yt-dlp** inside the pipeline worker, with a rights
declaration, a hard timeout, a size cap and classified failures. See
[`docs/YOUTUBE-IMPORT.md`](docs/YOUTUBE-IMPORT.md).

## Repository map

```
apps/api                     NestJS API + 5 worker roles (pipeline, render, publish, scheduler, recovery)
apps/web                     Next.js 15 dashboard (YouTube-first create flow, clip review, publishing)
packages/database            Prisma schema, repositories, job state machine, outbox, crypto
packages/shared-types        Job states, config keys, enums, DTO shapes
packages/validation          Zod schemas shared by the API and the dashboard
packages/platform-connectors YouTube Data API v3 + Instagram Graph API clients, error classification
services/ai-engine           FastAPI: transcription, frame sampling, Gemini analysis, clip selection
services/video-processor     FastAPI: framing, subtitles, loudness, 9:16 render + content validation
tests                        unit (vitest) · integration (vitest + Postgres) · python · e2e (live stack)
infrastructure               Dockerfiles, compose, Caddy, backups, health scripts
scripts                      developer automation (not shipped)
docs                         architecture, configuration, YouTube import, operations, testing
```

Every folder has its own README. For a file-by-file map see
[`docs/FOLDER-STRUCTURE.md`](docs/FOLDER-STRUCTURE.md) and [`docs/CODE-MAP.md`](docs/CODE-MAP.md).

## Quickstart (local, no Docker)

Requirements: Node 20.20+ (the repo pins 22.22.3), Python 3.11+, PostgreSQL 16+, Redis 7+,
FFmpeg 6+, and `yt-dlp` if you want the paste-a-URL flow.

```bash
cp .env.example .env                # replace example.com origins and fill in every REQUIRED value
npm install
npm run doctor:youtube              # yt-dlp / ffmpeg / cookies / import limits on this host

# database
npm run db:generate
npm run db:migrate

# shared packages, then the apps
npm run build:packages
npm run dev:api                     # http://localhost:4000  (Swagger at /api/docs)
npm run dev:web                     # http://localhost:3000

# python services (one venv is enough)
python3 -m venv .venv && . .venv/bin/activate
pip install -r services/ai-engine/requirements.txt -r services/video-processor/requirements.txt
PYTHONPATH=. uvicorn app.main:app --app-dir services/ai-engine --port 8100
PYTHONPATH=. uvicorn app.main:app --app-dir services/video-processor --port 8200

# background workers
bash apps/api/scripts/run-workers.sh
```

First run: open `/login` and complete the Telegram sign-in flow. There is no seeded user and no
default password.

Prefer containers? `docker compose -f docker-compose.dev.yml up --build` (the API image already
contains FFmpeg and yt-dlp).

## Configuration you actually need

| Area | Variables |
| --- | --- |
| Core | `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `APP_URL`, `ALLOWED_ORIGINS`, `WORK_DIR` |
| AI | `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `AI_ENGINE_URL`, `AI_ENGINE_API_KEY`, `AI_ENGINE_MAX_CONCURRENT_WORK` |
| Rendering | `VIDEO_PROCESSOR_URL`, `VIDEO_PROCESSOR_API_KEY`, `FFMPEG_PATH`, `FFPROBE_PATH`, `VIDEO_PROCESSOR_MAX_CONCURRENT_WORK`, `VIDEO_PROCESSOR_MAX_CONCURRENT_PROBES` |
| YouTube import | `YOUTUBE_IMPORT_ENABLED`, `YTDLP_PATH`, `YOUTUBE_IMPORT_MAX_HEIGHT`, `YOUTUBE_IMPORT_TIMEOUT_SECONDS`, optional `YOUTUBE_COOKIES_FILE` |
| Publishing | `YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI`, `META_APP_ID/SECRET/REDIRECT_URI`, `META_GRAPH_API_VERSION` |
| Storage | `STORAGE_DRIVER=local|s3`, plus the matching S3 settings (Instagram publishing needs a public HTTPS media URL) |

The dashboard surfaces what is still missing (`/settings`), and `/api/system/readiness` reports it
machine-readably.

## Quality gates

```bash
npm run verify              # structure + build + typecheck + lint + unit tests
npm run test:unit           # vitest, no external services required
npm run test:integration    # requires PostgreSQL + Redis
npm run test:python         # renderer/ai-engine unit tests
bash infrastructure/scripts/healthcheck.sh
```

`npm run verify:structure` fails when the tree drifts from the layout described in
`docs/FOLDER-STRUCTURE.md`.

## External integrations

| Integration | Code | Verification |
| --- | --- | --- |
| YouTube URL import (yt-dlp) | implemented | needs `yt-dlp` + `ffmpeg` on the worker host; unit-tested argument/progress/failure logic |
| Gemini (analysis + captions) | implemented | needs `GEMINI_API_KEY`; `TEST_MODE=1` provides a deterministic fixture provider for tests only |
| YouTube Data API v3 (publishing) | implemented | needs an OAuth client with `youtube.upload` |
| Instagram Graph API (Reels) | implemented | needs a Meta app, an Instagram Business account and a public media URL |
| S3 / Cloudflare R2 | implemented | local filesystem driver is the default; S3 for public Reels delivery |
| Telegram (auth + notifications) | implemented | needs a bot token and webhook secret |

## Documentation

Start with [`docs/README.md`](docs/README.md) (index), then:

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, state machine, data model
* [`docs/YOUTUBE-IMPORT.md`](docs/YOUTUBE-IMPORT.md) — the paste-a-URL flow, rails and troubleshooting
* [`docs/PLATFORM-SETUP.md`](docs/PLATFORM-SETUP.md) — creating the Google/Meta apps, step by step
* [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — every environment variable
* [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — running, monitoring, backups, recovery
* [`docs/TESTING.md`](docs/TESTING.md) — what each suite proves
* [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — the evidence behind current claims
