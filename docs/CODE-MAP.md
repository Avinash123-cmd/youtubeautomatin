# ClipForge AI — code map

Every file that makes up this project, with its line count and what it does. This is an index, not a copy: the code lives at the path shown. Regenerate with `.venv/bin/python scripts/build-code-map.py` — do not hand-edit.

**303 source files · 38,190 lines · 392 files tracked in git**

Repository root `/home/user/clipforge-ai` · branch `master` · HEAD `b6f1b5c`


## API server — `apps/api`

100 source files · 13,973 lines

| file | lines | purpose |
| --- | ---: | --- |
| `apps/api/README.md` | 42 | `apps/api` — backend API and workers |
| `apps/api/package.json` | 62 | — |
| `apps/api/scripts/run-workers.sh` | 72 | !/usr/bin/env bash |
| `apps/api/src/accounts/accounts.controller.ts` | 99 | — |
| `apps/api/src/accounts/accounts.module.ts` | 12 | — |
| `apps/api/src/accounts/accounts.service.ts` | 507 | Signed, single-use, server-stored OAuth state (Redis, 10 minute TTL). |
| `apps/api/src/app.module.ts` | 46 | — |
| `apps/api/src/auth/auth.controller.ts` | 247 | — |
| `apps/api/src/auth/auth.module.ts` | 20 | Legacy controllers/services remain in source for migration history but are not registered. No password, Firebase, OIDC, email recovery or recovery-cod |
| `apps/api/src/auth/auth.service.ts` | 462 | One-time administrator bootstrap. Refuses once any user exists, so there is no permanently privileged public account and no default credentials. |
| `apps/api/src/auth/bot-auth.controller.ts` | 108 | Response failures are server errors, not client Zod input-validation failures. |
| `apps/api/src/auth/bot-security.controller.ts` | 86 | Optional Telegram-only step-up: this code can revoke sessions, never authenticate. |
| `apps/api/src/auth/bot-session-description.ts` | 49 | Preserve the existing workspace/readiness session contract without loading retired providers. |
| `apps/api/src/auth/firebase.service.ts` | 167 | What the API trusts after verifying a Firebase ID token. |
| `apps/api/src/auth/otp.service.ts` | 298 | One-time codes for login step-up, password reset and Telegram linking. The rules are the feature, so they live here rather than in the controller: - * |
| `apps/api/src/auth/password-hash.ts` | 13 | Password hashing parameters, in their own module so services that need to *set* a password (reset, recovery code) do not have to import the whole Auth |
| `apps/api/src/auth/pending-step-up.ts` | 44 | Provider redirects carry no challenge data in URLs and never issue an authenticated session. |
| `apps/api/src/auth/security.controller.ts` | 220 | Account security surface: second-factor step-up, password recovery, sessions, login history, recovery codes and Telegram linking. Authorisation rules  |
| `apps/api/src/auth/security.service.ts` | 588 | Account security: second-factor login, password reset, sessions/devices, login history, recovery codes and suspicious-login alerts. Kept apart from `A |
| `apps/api/src/auth/session.service.ts` | 205 | Constant-time comparison of two same-length strings (node's helper is buffer-typed). |
| `apps/api/src/auth/telegram-account.service.ts` | 176 | The webhook secret is checked by the controller before any update reaches this method. |
| `apps/api/src/auth/telegram-bot-login.service.ts` | 97 | Called ONLY after webhook secret + update schema validation; no identity accepted from browser. |
| `apps/api/src/auth/telegram-oidc.service.ts` | 286 | Verify Telegram's signed ID token against an already fetched JWKS document. |
| `apps/api/src/clips/captions.ts` | 108 | Caption (subtitle) generation for a rendered clip. The renderer burns word-highlighted captions into the video; this module produces the same speech a |
| `apps/api/src/clips/clips.controller.ts` | 56 | — |
| `apps/api/src/clips/clips.module.ts` | 6 | — |
| `apps/api/src/clips/clips.service.ts` | 259 | Captions for one clip, derived from the stored word-level transcript of its source. Nothing is generated here beyond formatting: the timings are the o |
| `apps/api/src/common/auth-http.middleware.ts` | 17 | Run before CORS and guards so their failures have correlation IDs too. |
| `apps/api/src/common/database.module.ts` | 7 | One lifecycle owner for the shared Prisma client, not one per feature module. |
| `apps/api/src/common/decorators/auth.decorators.ts` | 23 | Marks a route as reachable without a session (login/register/health/callbacks). |
| `apps/api/src/common/decorators/rate-limit.decorator.ts` | 11 | Additional IP budget for authenticated security actions. |
| `apps/api/src/common/development-access.ts` | 47 | No session or identity is created. Only an explicitly selected local sandbox membership is used. |
| `apps/api/src/common/env.ts` | 315 | Environment parsing with zod. Every value a feature needs is required explicitly; there are no silent fallbacks. Failures are collected so the operato |
| `apps/api/src/common/filters/all-exceptions.filter.ts` | 89 | Single error shape for the whole API: { error: { code, message, details?, missingConfiguration?, requestId } } |
| `apps/api/src/common/guards/csrf.guard.ts` | 50 | Double-submit CSRF protection. The token is delivered in the session-info payload (never in a cookie readable by JS), and must be echoed in the `x-csr |
| `apps/api/src/common/guards/rate-limit.guard.ts` | 74 | Redis-backed fixed-window limiter, per-user when authenticated and per-IP otherwise. Two budgets exist, on purpose: - **The default.** Any *unsafe* re |
| `apps/api/src/common/guards/session-auth.guard.ts` | 50 | — |
| `apps/api/src/common/health-probe.ts` | 17 | Bounds monitor latency even for drivers that queue commands during an outage. This limits the wait; it does not cancel an already executing database c |
| `apps/api/src/common/http-listener.ts` | 11 | PORT belongs to the host; API_PORT is the backward-compatible local fallback. |
| `apps/api/src/common/interceptors/request-id.interceptor.ts` | 23 | — |
| `apps/api/src/common/origin-policy.ts` | 44 | Explicit origins only. Host / forwarded-host are routing metadata, never trust anchors. |
| `apps/api/src/common/prisma.service.ts` | 26 | — |
| `apps/api/src/common/security-headers.ts` | 39 | Helmet configuration for the API, kept out of `main.ts` so it can be asserted in a unit test. This API answers with JSON and media bytes, never HTML.  |
| `apps/api/src/common/services/config.service.ts` | 77 | Reads configuration and fails closed with the exact missing keys. |
| `apps/api/src/common/services/email.service.ts` | 138 | Outbound email over SMTP (Gmail, or any SMTP host). Design mirrors the Telegram client on purpose, because both are "an external channel that must nev |
| `apps/api/src/common/services/logger.service.ts` | 39 | Structured JSON logs (pino) — one line per event, machine-parseable. |
| `apps/api/src/common/services/redis.service.ts` | 65 | Redis is used for: rate limits, worker presence/heartbeats, queue metadata and short-lived caches. It is never the source of truth for business state  |
| `apps/api/src/common/services/usage-cost.ts` | 114 | Unit economics for everything the pipeline spends money on. Every `UsageRecord` written to the database carries a `quantity` in a natural unit (second |
| `apps/api/src/common/startup-error.ts` | 13 | Carries operator guidance only: no raw driver exception/cause or credentials. |
| `apps/api/src/common/telegram-webhook-url.ts` | 16 | A Telegram webhook must be a public HTTPS hostname, never a local development listener. Syntactic validation only: the operator must still verify DNS/ |
| `apps/api/src/jobs/jobs.controller.ts` | 52 | — |
| `apps/api/src/jobs/jobs.module.ts` | 13 | — |
| `apps/api/src/jobs/jobs.service.ts` | 394 | Manual retry: re-enters the state machine and re-enqueues a durable intent. |
| `apps/api/src/load-env.ts` | 17 | Loads .env for local/container runs. In production the platform injects real environment variables; .env is only used where an operator placed it. |
| `apps/api/src/main.ts` | 94 | — |
| `apps/api/src/media/media-validation.service.ts` | 129 | FFprobe-backed media validation. Never trusts the declared MIME type alone. |
| `apps/api/src/media/media.controller.ts` | 144 | Object delivery. The local storage driver exposes objects here with HTTP Range support so the dashboard can scrub video. Keys are resolved from the da |
| `apps/api/src/media/ssrf-guard.ts` | 158 | SSRF protection for the "import from direct URL" source path. Rules enforced before any outbound request: - scheme must be http(s) (https in productio |
| `apps/api/src/notifications/notification-format.ts` | 97 | Message rendering for Telegram notifications. Pure functions, no I/O: every message the system sends is built here, which makes the wording reviewable |
| `apps/api/src/notifications/notifications.controller.ts` | 116 | Operator surface for the Telegram channel. Everything here is OWNER/ADMIN only and scoped to the caller's workspace: chat ids and delivery history are |
| `apps/api/src/notifications/notifications.module.ts` | 15 | The service is exported because other modules (auth, accounts, jobs) inject it to emit events. It is a singleton per process: the bot identity probe c |
| `apps/api/src/notifications/notifications.service.ts` | 550 | Telegram notification delivery. Design constraints, in the order they shaped the code: 1. **A notification may never break the work it reports on.** ` |
| `apps/api/src/notifications/telegram.client.ts` | 273 | Telegram Bot API client. Deliberately a plain class, not a Nest provider: the workers construct their own instance (`new TelegramClient()`) the same w |
| `apps/api/src/publishing/publishing-query.ts` | 16 | — |
| `apps/api/src/publishing/publishing.controller.ts` | 54 | — |
| `apps/api/src/publishing/publishing.module.ts` | 13 | — |
| `apps/api/src/publishing/publishing.service.ts` | 390 | Enables/disables automatic publishing for one connected account. Every precondition is explicit: connected account, permissions, storage that the plat |
| `apps/api/src/queues/queue.service.ts` | 109 | BullMQ queue registry + transactional-outbox relay. Business code never enqueues directly: it writes an OutboxEvent inside the same transaction as the |
| `apps/api/src/queues/queues.module.ts` | 7 | — |
| `apps/api/src/sources/source-dto.ts` | 69 | One shape for a source video in every API response. The upload flow, the direct-URL import and the YouTube ingest all return sources, so the mapping l |
| `apps/api/src/sources/source-key.ts` | 9 | One storage-key convention for every source kind. Workspace prefix first so a key can never be reused across tenants, source id second so re-ingesting |
| `apps/api/src/sources/sources.controller.ts` | 103 | — |
| `apps/api/src/sources/sources.module.ts` | 15 | — |
| `apps/api/src/sources/sources.service.ts` | 501 | Declared to the browser at upload initiation; the browser is not allowed to pick its own. |
| `apps/api/src/sources/youtube/ingest.ts` | 62 | The ingest step of the pipeline for URL-based sources. Kept separate from the Nest service so the worker can call it with an explicit service instance |
| `apps/api/src/sources/youtube/preview.ts` | 81 | YouTube preview metadata — the part of the pasted-URL flow that must be instant. oEmbed is used first because it needs no API key and answers in one r |
| `apps/api/src/sources/youtube/youtube-import.service.ts` | 317 | YouTube source import. The API only *records* the request and resolves preview metadata; the bytes are fetched by the pipeline worker during PROBING ( |
| `apps/api/src/sources/youtube/ytdlp.ts` | 387 | yt-dlp integration — pure helpers plus one carefully bounded process runner. Everything that decides *what* is executed lives in this file and is unit |
| `apps/api/src/storage/storage.module.ts` | 6 | — |
| `apps/api/src/storage/storage.service.ts` | 353 | Object storage abstraction. `STORAGE_DRIVER` is explicit (env). There is no driver fallback: if S3 is selected but misconfigured the API refuses to st |
| `apps/api/src/system/dashboard.controller.ts` | 16 | — |
| `apps/api/src/system/diagnostics.controller.ts` | 23 | Diagnostics live in their own controller so the route table reads as two surfaces: `/api/system` (health, queues, events) and `/api/system/diagnostics |
| `apps/api/src/system/diagnostics.service.ts` | 412 | Builds the operator diagnostics report. Thresholds are deliberately conservative and are written into the finding text, so nobody has to read this fil |
| `apps/api/src/system/diagnostics.types.ts` | 64 | Diagnostics: the questions an operator actually asks when something looks wrong at 2am. - is anything stuck, and since when? - is the outbox draining? |
| `apps/api/src/system/system.controller.ts` | 71 | Public probes never include driver exceptions, hostnames, credentials, worker IDs or paths. |
| `apps/api/src/system/system.module.ts` | 15 | — |
| `apps/api/src/system/system.service.ts` | 278 | Worker presence is derived from Redis heartbeats renewed by each worker. |
| `apps/api/src/usage/usage.controller.ts` | 38 | Usage and cost reporting. Operator-only: spend per workspace is commercially sensitive and is not part of a member's job. Every query is scoped to the |
| `apps/api/src/usage/usage.module.ts` | 6 | — |
| `apps/api/src/usage/usage.service.ts` | 221 | Default reporting window: the last 30 days, which is what a monthly review looks at. |
| `apps/api/src/workers/base.ts` | 139 | Boots a long-lived worker process: - registers itself in Redis with a heartbeat so the admin dashboard shows real liveness - renews leases for the job |
| `apps/api/src/workers/lease-contention.ts` | 23 | Lease contention is scheduling, not success or a failed processing attempt. |
| `apps/api/src/workers/pipeline-errors.ts` | 18 | Errors the pipeline worker can classify without guessing. `needsConfiguration` means the job must stop in NEEDS_CONFIGURATION and wait for an operator |
| `apps/api/src/workers/pipeline.worker.ts` | 793 | Pipeline worker — owns stages PROBING → TRANSCRIBING → AI_ANALYSIS → CLIP_SELECTION → RENDERING hand-off. Durability: every stage transition is a comm |
| `apps/api/src/workers/publish.worker.ts` | 546 | Publishing worker — YouTube upload and Instagram Reel publication. Guarantees: - exactly one attempt per (clip, platform, account, operation) is ever  |
| `apps/api/src/workers/recovery.worker.ts` | 72 | Recovery worker — makes the platform survive crashes. Every 30 seconds it looks for jobs whose worker lease expired while unfinished, checks whether t |
| `apps/api/src/workers/render.worker.ts` | 379 | Render worker — turns one planned clip into a real vertical MP4 with burned subtitles, stores it, and advances the job once every clip is rendered. |
| `apps/api/src/workers/scheduler.worker.ts` | 289 | Scheduler worker — the only process allowed to talk to BullMQ for dispatch. Duties: 1. drain the transactional outbox into BullMQ (1s cadence), 2. ref |
| `apps/api/src/workers/services-client.ts` | 208 | Typed clients for the Python services. Every call has a timeout and surfaces the service's structured error instead of swallowing it. |
| `apps/api/src/workspace/workspace.controller.ts` | 78 | Branding assets (logo overlay, intro, outro) must be *uploadable*: the render pipeline reads them from storage, so leaving only a raw `storageKey` fie |
| `apps/api/src/workspace/workspace.module.ts` | 6 | — |
| `apps/api/src/workspace/workspace.service.ts` | 198 | Stores a brand asset and returns the storage key the render pipeline will download from. The key is workspace-scoped, so one workspace can never point |
| `apps/api/tsconfig.json` | 14 | — |

## Web dashboard — `apps/web`

43 source files · 5,752 lines

| file | lines | purpose |
| --- | ---: | --- |
| `apps/web/README.md` | 35 | `apps/web` — dashboard |
| `apps/web/api-target.json` | 4 | — |
| `apps/web/app/accounts/page.tsx` | 273 | — |
| `apps/web/app/activity/page.tsx` | 54 | — |
| `apps/web/app/admin/page.tsx` | 180 | One colour vocabulary across the app: green = fine, amber = look soon, red = act now. |
| `apps/web/app/brand/page.tsx` | 273 | — |
| `apps/web/app/calendar/page.tsx` | 43 | — |
| `apps/web/app/clips/page.tsx` | 342 | Per-platform metadata is editable before publishing — the API has supported PATCH since the start, so a read-only panel left a required workflow unrea |
| `apps/web/app/create/page.tsx` | 538 | A 428 from the API is actionable: show which setting is missing instead of a bare message. |
| `apps/web/app/forgot-password/page.tsx` | 4 | Legacy bookmarks cannot expose an alternative authentication flow. |
| `apps/web/app/globals.css` | 79 | — |
| `apps/web/app/healthz/route.ts` | 89 | Deployment self-check for the dashboard. `/api/*` and `/media/*` are rewrites to the API origin baked in at build time, so the single most common fail |
| `apps/web/app/jobs/[id]/page.tsx` | 159 | — |
| `apps/web/app/jobs/page.tsx` | 102 | — |
| `apps/web/app/layout.tsx` | 32 | — |
| `apps/web/app/login/page.tsx` | 85 | — |
| `apps/web/app/page.tsx` | 188 | — |
| `apps/web/app/publishing/page.tsx` | 144 | — |
| `apps/web/app/register/page.tsx` | 4 | Legacy bookmarks cannot expose an alternative authentication flow. |
| `apps/web/app/security/page.tsx` | 42 | — |
| `apps/web/app/settings/page.tsx` | 345 | — |
| `apps/web/app/videos/page.tsx` | 213 | — |
| `apps/web/components/backend-down.tsx` | 103 | Shown when `/api/auth/session` could not be answered at all — the API origin baked into the rewrite is down, wrong, or blocked. On a fresh Vercel depl |
| `apps/web/components/clip-player.tsx` | 39 | Vertical clip preview with an honest failure state. A stored object can disappear out of band (bucket lifecycle rule, manual delete, a restored databa |
| `apps/web/components/deploy-check.tsx` | 59 | The one link that is easy to break on Vercel: the dashboard's build-time API origin. Everything else on /admin is served *by* the API, so it can only  |
| `apps/web/components/job-analysis.tsx` | 42 | — |
| `apps/web/components/notifications-panel.tsx` | 286 | Telegram notification settings. State is owned by the API: toggles/config are persisted, status is measured (bot identity, last delivery, 24h counters |
| `apps/web/components/providers.tsx` | 16 | — |
| `apps/web/components/shell.tsx` | 377 | Routes shown in the phone bottom bar; everything else lives behind "More". |
| `apps/web/components/ui.tsx` | 437 | The first Section on a page is that page's document heading (`h1`); the rest stay `h2`. |
| `apps/web/eslint.config.mjs` | 21 | Next's own rules, plus the two that actually catch bugs in this codebase. |
| `apps/web/instrumentation.ts` | 15 | Probe the same compiled API target used by rewrites; never start another API process. |
| `apps/web/lib/api-origin.ts` | 11 | Build input, not a secret. Accept a bare HTTP(S) origin or the common /api suffix only. |
| `apps/web/lib/api.ts` | 262 | A deployed dashboard can fail in ways a local one cannot: the API origin in the build-time rewrite is wrong, the API is down, or the proxy in front of |
| `apps/web/lib/auth-messages.ts` | 75 | Users should read what to do, not what threw. Every branch below is a state this deployment can actually reach — the codes come from the API and the p |
| `apps/web/lib/bot-auth-api.ts` | 26 | A successful HTTP status is not proof that a response matches the login protocol. |
| `apps/web/lib/bot-login-state.ts` | 26 | — |
| `apps/web/lib/calendar.ts` | 7 | Local-browser month boundaries; the API receives explicit UTC instants. |
| `apps/web/lib/config-schema.ts` | 61 | Field metadata only — no values. Defaults are deliberately absent: every value must be set explicitly by an operator, matching the API's Configuration |
| `apps/web/lib/hooks.ts` | 451 | Operator surfaces (system, usage, workspace configuration, brand assets, OAuth accounts) are OWNER/ADMIN only on the API. Pages must ask the same ques |
| `apps/web/lib/processing-request.ts` | 45 | Translate saved workspace settings to the actual API contract, before uploading any bytes. `intent` is opt-in: with no argument the job is review-only |
| `apps/web/lib/source-rights.ts` | 6 | Full legal attestations, not short enum codes that fail the API's minimum statement length. |
| `apps/web/lib/upstream-diagnostics.ts` | 16 | Allowlisted transport metadata only: never emit raw errors, headers, cookies or bodies. |
| `apps/web/lib/youtube.ts` | 73 | Client-side YouTube helpers. The browser only needs to answer "is this worth asking the API about?" and to render a thumbnail before the request retur |
| `apps/web/next-env.d.ts` | 6 | — |
| `apps/web/next.config.ts` | 154 | The browser only ever talks to this Next.js origin. /api and /media are proxied to the NestJS API through rewrites, so session cookies stay same-origi |
| `apps/web/package.json` | 35 | — |
| `apps/web/tailwind.config.ts` | 49 | Design tokens. The palette is intentionally small: one indigo accent, a slate neutral ramp and three semantic pairs. Every page composes those tokens, |
| `apps/web/tsconfig.json` | 10 | — |
| `apps/web/vercel.json` | 19 | — |

## Shared packages — `packages`

30 source files · 4,984 lines

| file | lines | purpose |
| --- | ---: | --- |
| `packages/README.md` | 23 | packages/ — code shared by more than one app |
| `packages/database/README.md` | 21 | `packages/database` — schema, client, repositories |
| `packages/database/package.json` | 8 | — |
| `packages/database/prisma/migrations/20261109065140_init/migration.sql` | 873 | — |
| `packages/database/prisma/migrations/20261109081312_brand_asset_audit_action/migration.sql` | 10 | — |
| `packages/database/prisma/migrations/20261110142325_firebase_auth_link/migration.sql` | 8 | — |
| `packages/database/prisma/migrations/20261110170000_telegram_notifications/migration.sql` | 51 | — |
| `packages/database/prisma/migrations/20261111080000_otp_security/migration.sql` | 86 | — |
| `packages/database/prisma/migrations/20261111081500_security_audit_events/migration.sql` | 20 | — |
| `packages/database/prisma/migrations/20261111083000_user_otp_fields/migration.sql` | 5 | — |
| `packages/database/prisma/migrations/20261116000000_telegram_bot_login/migration.sql` | 24 | — |
| `packages/database/prisma/migrations/20261116120000_telegram_webhook_control/migration.sql` | 9 | — |
| `packages/database/prisma/migrations/20261116140000_unified_telegram_auth/migration.sql` | 42 | — |
| `packages/database/prisma/migrations/20261116160000_caption_provenance/migration.sql` | 3 | — |
| `packages/database/prisma/migrations/20261117090000_youtube_source_kind/migration.sql` | 3 | — |
| `packages/database/prisma/migrations/20261117091000_youtube_source_metadata/migration.sql` | 3 | — |
| `packages/database/prisma/schema.prisma` | 1118 | — |
| `packages/database/src/client.ts` | 23 | Single Prisma client per process. Workers and API both use this. Connection pooling is handled by pg via the DATABASE_URL parameters. |
| `packages/database/src/config.ts` | 103 | Configuration resolution. Precedence: workspace-scoped ApplicationConfiguration row > global row. There is NO code-level default for any business valu |
| `packages/database/src/crypto.ts` | 78 | Cryptography helpers. - OAuth tokens are encrypted at rest with AES-256-GCM using CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64). Ciphertext is stored a |
| `packages/database/src/index.ts` | 7 | — |
| `packages/database/src/outbox.ts` | 85 | Transactional outbox. The row is written inside the same transaction as the state change, so a committed business change always has a matching queue i |
| `packages/database/src/recovery.ts` | 46 | Recheck under the same row lock as transitions and lease claims; never trust sweep snapshots. |
| `packages/database/src/repositories.ts` | 299 | Creates the job + its initial stage row + the outbox intent atomically. Nothing is put in memory: a crash immediately after this commit still results  |
| `packages/database/src/seed.ts` | 122 | Seed script. Deliberately creates NO user, NO password and NO business configuration. The only rows inserted are the *catalogue* of selectable subtitl |
| `packages/database/tsconfig.json` | 1 | — |
| `packages/platform-connectors/README.md` | 7 | `packages/platform-connectors` |
| `packages/platform-connectors/package.json` | 4 | — |
| `packages/platform-connectors/src/http.ts` | 116 | Shared HTTP + error classification used by every platform connector. No simulated responses: these functions only ever return what the platform return |
| `packages/platform-connectors/src/index.ts` | 3 | — |
| `packages/platform-connectors/src/instagram.ts` | 216 | Instagram content publishing connector — official Meta API only. Documentation verified 2026-11-09: - Latest Graph API version: v27.0 (v26.0 released  |
| `packages/platform-connectors/src/youtube.ts` | 291 | YouTube Data API v3 connector. Docs (verified 2026-11-09): - videos.insert (resumable upload, 1600 quota units per upload): https://developers.google. |
| `packages/platform-connectors/tsconfig.json` | 10 | — |
| `packages/shared-types/README.md` | 6 | `packages/shared-types` |
| `packages/shared-types/package.json` | 13 | — |
| `packages/shared-types/src/index.d.ts` | 279 | @clipforge/shared-types Contract shared by the API, workers and the web app. Kept dependency-free. |
| `packages/shared-types/src/index.ts` | 501 | @clipforge/shared-types Contract shared by the API, workers and the web app. Kept dependency-free. |
| `packages/shared-types/tsconfig.json` | 1 | — |
| `packages/validation/README.md` | 32 | `packages/validation` |
| `packages/validation/package.json` | 20 | — |
| `packages/validation/src/domain.ts` | 185 | Domain rules that both the API and workers depend on. Pure functions only — unit-tested in tests/unit. |
| `packages/validation/src/index.ts` | 375 | The single password policy. Every path that writes a password hash must use this schema — registration, bootstrap, reset-by-code and recovery-code red |
| `packages/validation/tsconfig.json` | 10 | — |

## Python services — `services`

19 source files · 3,566 lines

| file | lines | purpose |
| --- | ---: | --- |
| `services/ai-engine/README.md` | 25 | `services/ai-engine` — transcription and analysis |
| `services/ai-engine/app/__init__.py` | 0 | — |
| `services/ai-engine/app/captions.py` | 167 | Platform-specific caption/metadata generation. YouTube and Instagram get genuinely different copy (search-oriented vs. hook-driven), both constrained  |
| `services/ai-engine/app/config.py` | 74 | Runtime configuration for the AI engine. Nothing here has a silent default for a business-critical decision: - The AI provider is explicit. There is n |
| `services/ai-engine/app/fixture_provider.py` | 78 | TEST-ONLY analysis provider. This module exists so the pipeline can be exercised end-to-end in isolated automated test environments where no Gemini AP |
| `services/ai-engine/app/gemini.py` | 180 | Gemini API client with structured output, bounded retries and schema validation. Docs (verified 2026-11-09): https://ai.google.dev/gemini-api/docs/str |
| `services/ai-engine/app/main.py` | 189 | AI engine HTTP service. Endpoints GET /health — liveness + capability report (never claims readiness it lacks) POST /transcribe — transcription only ( |
| `services/ai-engine/app/media.py` | 232 | FFmpeg / FFprobe wrappers: probing, audio extraction and resource-efficient frame sampling with scene-change detection. No frame is ever produced twic |
| `services/ai-engine/app/pipeline.py` | 247 | Full analysis pipeline: inspect → extract audio → transcribe → see → understand → validate → de-duplicate → plan dual-duration variants. |
| `services/ai-engine/app/selection.py` | 600 | Highlight candidate generation, validation, scoring, de-duplication and dual-duration variant planning. Design rules encoded here: * The model propose |
| `services/ai-engine/app/timing.py` | 50 | Validate ASR timestamps before they can drive subtitle or trim commands. No retiming or invented words: invalid source/provider data fails explicitly. |
| `services/ai-engine/app/transcribe.py` | 99 | Accurate transcription with word-level timestamps (faster-whisper). Timestamps come straight from the model and are never invented or rounded to whole |
| `services/ai-engine/app/vision.py` | 142 | Visual intelligence: describe representative frames with a vision model. Cost control: only frames that survived scene-detection + de-duplication are  |
| `services/media_paths.py` | 20 | Filesystem boundary for authenticated media RPCs. Workers and Python services must mount WORK_DIR at the same absolute path. Paths are files, never UR |
| `services/video-processor/README.md` | 21 | `services/video-processor` — rendering |
| `services/video-processor/app/__init__.py` | 0 | — |
| `services/video-processor/app/audio.py` | 121 | Audio analysis: loudness, true peak, silence ranges, clipping detection. All measurements come from FFmpeg's own filters — nothing is estimated. |
| `services/video-processor/app/framing.py` | 238 | Intelligent vertical framing. Face detection uses OpenCV's Haar cascade (CPU-only, no model download) sampled at a fixed rate, then a temporal tracker |
| `services/video-processor/app/main.py` | 213 | Video processor HTTP service. Endpoints GET /health — liveness + FFmpeg availability POST /probe — ffprobe inspection (used by the API's upload valida |
| `services/video-processor/app/renderer.py` | 604 | FFmpeg rendering: vertical composition, framing, burned subtitles and loudness-normalised audio. Output is verified with ffprobe after encoding. |
| `services/video-processor/app/subtitles.py` | 312 | Word-timed subtitle generation (ASS) with karaoke-style highlighting. The style is always an explicit user/administrator choice; nothing is hardcoded  |

## Tests — `tests`

94 source files · 8,785 lines

| file | lines | purpose |
| --- | ---: | --- |
| `tests/README.md` | 29 | `tests/` |
| `tests/e2e/auth_security.py` | 338 | End-to-end checks for the account-security surface, against the live stack. What this suite deliberately does NOT do: * It does not stub SMTP, the dat |
| `tests/e2e/authorization_matrix.py` | 240 | Authorization matrix against a running ClipForge stack. Three questions this answers, with evidence rather than inspection: 1. Can an unauthenticated  |
| `tests/e2e/firebase_auth.py` | 196 | Google sign-in contract, end to end. Covers the three layers that can each break silently: 1. what the API advertises to the login screen (GET /api/au |
| `tests/e2e/full_workflow.py` | 259 | End-to-end workflow test against a running ClipForge stack. Exercises the real HTTP API and the real workers: verify an existing Telegram-authenticate |
| `tests/e2e/harness.py` | 230 | Shared helpers for the ClipForge end-to-end suites. Both `authorization_matrix.py` and `scenarios.py` drive the live stack through its real HTTP API w |
| `tests/e2e/logic_probes.py` | 214 | Adversarial probes of the core algorithms — does the logic hold, not just the happy path? The unit tests check the happy paths the product needs. Thes |
| `tests/e2e/run_auth_security.sh` | 29 | !/usr/bin/env bash |
| `tests/e2e/scenarios.py` | 644 | Nineteen end-to-end scenarios against a running ClipForge stack. Each scenario answers one question an operator or reviewer would ask, and prints the  |
| `tests/e2e/security_headers.py` | 238 | Security-header and rate-limit suite for the live ClipForge stack. Three things this proves that a unit test cannot: 1. The running API and the runnin |
| `tests/e2e/smtp_sink.py` | 69 | A real SMTP server that writes every delivered message to disk. The one-time-code tests need to read the code that was actually mailed. Faking `EmailS |
| `tests/e2e/telegram_notifications.py` | 540 | End-to-end verification of the Telegram notification system against the live stack. What makes this an end-to-end test and not a mock: the API is a re |
| `tests/e2e/ui_responsive.py` | 213 | Browser-level UI audit for the ClipForge dashboard. Runs the real Next.js build in headless Chromium against the real API at five viewports (phone → d |
| `tests/integration/database.test.ts` | 245 | Integration tests against the real PostgreSQL database. These exercise the durable primitives the workers rely on: the job state machine, worker lease |
| `tests/integration/firebase-auth.test.ts` | 148 | Google sign-in decides who may enter the workspace. These tests drive `resolveFirebaseUser` directly — token verification and session issuing are sepa |
| `tests/integration/notifications.test.ts` | 373 | Integration tests for Telegram notifications against a real PostgreSQL database. The only fake is the Telegram endpoint itself: a local HTTP server, b |
| `tests/integration/storage.test.ts` | 89 | Integration tests for the local storage driver's byte-exact behaviour. Both cases are regressions from a real defect: ranged reads that ignored the of |
| `tests/python/test_ai_fixture_guard.py` | 18 | Fixture inference is isolated-test-only, never a production escape hatch. |
| `tests/python/test_analysis_integrity.py` | 145 | Real validation/selection tests; model responses are explicit isolated test inputs. |
| `tests/python/test_media_paths.py` | 40 | — |
| `tests/python/test_render_http.py` | 29 | Real FFmpeg HTTP render smoke; synthetic media/timings are isolated fixtures, not AI evidence. |
| `tests/python/test_render_validation.py` | 210 | Tests for render output validation (probe + content scanning). Run with: .venv/bin/python tests/python/test_render_validation.py (or `npm run test:pyt |
| `tests/python/test_service_health.py` | 79 | HTTP boundary tests: tools/providers are stubbed; no render or cloud inference is claimed. |
| `tests/unit/api-origin.test.ts` | 7 | — |
| `tests/unit/auth-error-diagnostics.test.ts` | 17 | — |
| `tests/unit/auth-security.test.ts` | 163 | Unit tests for the pieces of the security feature that are pure logic: code generation, the hashing scheme, masking, device labels, and the SMTP confi |
| `tests/unit/bot-auth-contract.test.ts` | 47 | — |
| `tests/unit/bot-auth-http.test.ts` | 163 | — |
| `tests/unit/bot-login-render.test.ts` | 51 | — |
| `tests/unit/bot-login-state.test.ts` | 22 | — |
| `tests/unit/bot-rate-budgets.test.ts` | 18 | — |
| `tests/unit/bot-security-actions.test.ts` | 47 | — |
| `tests/unit/bot-webhook-registration.test.ts` | 23 | — |
| `tests/unit/caption-provenance.test.ts` | 17 | — |
| `tests/unit/clip-captions.test.ts` | 111 | Helper: evenly spaced words, 0.35 s each, starting at `start`. |
| `tests/unit/crypto.test.ts` | 55 | — |
| `tests/unit/csrf-injection.test.ts` | 95 | — |
| `tests/unit/dev-api-lifecycle.test.ts` | 44 | — |
| `tests/unit/development-access-http.test.ts` | 61 | — |
| `tests/unit/development-access.test.ts` | 55 | — |
| `tests/unit/development-shell.test.ts` | 16 | — |
| `tests/unit/diagnostics-isolation.test.ts` | 26 | — |
| `tests/unit/diagnostics.test.ts` | 40 | — |
| `tests/unit/firebase-config.test.ts` | 148 | Firebase Auth must degrade honestly: absent configuration hides Google sign-in instead of throwing at boot, and a *half*-configured deployment fails l |
| `tests/unit/foundation-env.test.ts` | 28 | — |
| `tests/unit/job-analysis-render.test.ts` | 22 | — |
| `tests/unit/job-analysis.test.ts` | 34 | — |
| `tests/unit/job-create-idempotency.test.ts` | 31 | — |
| `tests/unit/lease-contention.test.ts` | 30 | — |
| `tests/unit/load-env.test.ts` | 24 | — |
| `tests/unit/local-storage.test.ts` | 57 | — |
| `tests/unit/multipart-compatibility.test.ts` | 27 | — |
| `tests/unit/oauth-redirect-security.test.ts` | 19 | — |
| `tests/unit/origin-csrf.test.ts` | 81 | — |
| `tests/unit/otp-lifecycle.test.ts` | 75 | — |
| `tests/unit/pending-step-up.test.ts` | 42 | — |
| `tests/unit/platform-connectors.test.ts` | 103 | — |
| `tests/unit/private-media.test.ts` | 44 | — |
| `tests/unit/production-connections.test.ts` | 13 | — |
| `tests/unit/production-dependencies.test.ts` | 32 | — |
| `tests/unit/production-startup.test.ts` | 62 | — |
| `tests/unit/provider-step-up.test.ts` | 31 | — |
| `tests/unit/publishing-calendar.test.ts` | 38 | — |
| `tests/unit/redis-rate-limit.test.ts` | 18 | — |
| `tests/unit/repository-leases.test.ts` | 15 | — |
| `tests/unit/security-headers.test.ts` | 62 | The security headers are the one class of feature that can be silently lost: nothing in the app breaks when a header stops being sent, so only a test  |
| `tests/unit/service-contracts.test.ts` | 21 | — |
| `tests/unit/session-validation.test.ts` | 42 | — |
| `tests/unit/signed-media.test.ts` | 29 | — |
| `tests/unit/source-library.test.ts` | 39 | — |
| `tests/unit/startup-dependencies.test.ts` | 46 | — |
| `tests/unit/startup-log-security.test.ts` | 29 | — |
| `tests/unit/state-machine.test.ts` | 102 | — |
| `tests/unit/step-up-policy.test.ts` | 61 | — |
| `tests/unit/system-readiness.test.ts` | 56 | — |
| `tests/unit/telegram-bot-login.test.ts` | 122 | — |
| `tests/unit/telegram-bot-setup.test.ts` | 72 | — |
| `tests/unit/telegram-linking.test.ts` | 78 | — |
| `tests/unit/telegram-notifications.test.ts` | 339 | Unit tests for the Telegram client and message rendering. No network, no database, no timers: `fetch`, `sleep` and `random` are injected, so the retry |
| `tests/unit/telegram-oidc.test.ts` | 76 | — |
| `tests/unit/transactional-recovery.test.ts` | 68 | — |
| `tests/unit/typescript-toolchain.test.ts` | 28 | — |
| `tests/unit/upstream-diagnostics.test.ts` | 36 | — |
| `tests/unit/usage-cost.test.ts` | 83 | Prices are passed explicitly so the tests describe the arithmetic, not the deployment's environment. The defaults in envSchema are a separate concern  |
| `tests/unit/validation-package-entry.test.ts` | 65 | — |
| `tests/unit/validation.test.ts` | 120 | — |
| `tests/unit/web-auth-api.test.ts` | 72 | — |
| `tests/unit/web-processing-request.test.ts` | 36 | — |
| `tests/unit/web-security-headers.test.ts` | 103 | The dashboard serves HTML, so its policy is the one that can break the product if it is written wrong, and the one that silently disappears if it is d |
| `tests/unit/web-startup-health.test.ts` | 26 | — |
| `tests/unit/worker-launcher.test.ts` | 14 | — |
| `tests/unit/youtube-ingest.test.ts` | 211 | — |
| `tests/unit/youtube-source.test.ts` | 71 | — |
| `tests/vitest.config.ts` | 21 | — |
| `tests/vitest.integration.config.ts` | 19 | — |

## Developer scripts — `scripts`

9 source files · 817 lines

| file | lines | purpose |
| --- | ---: | --- |
| `scripts/README.md` | 21 | scripts/ |
| `scripts/build-code-bundle.py` | 108 | Build a single self-contained HTML file containing every source file of the project. The platform's file viewer renders one file at a time, so "where  |
| `scripts/build-code-map.py` | 93 | Regenerate docs/CODE-MAP.md: every tracked file with its line count and purpose. Kept as a script rather than hand-written so the map cannot drift fro |
| `scripts/check-api-keys.sh` | 56 | !/usr/bin/env bash |
| `scripts/check-firebase.sh` | 4 | !/usr/bin/env bash |
| `scripts/check-structure.sh` | 214 | !/usr/bin/env bash |
| `scripts/check-youtube-import.sh` | 93 | !/usr/bin/env bash |
| `scripts/deploy-vercel.sh` | 91 | !/usr/bin/env bash |
| `scripts/dev-up.sh` | 85 | !/usr/bin/env bash |
| `scripts/make-testdata.sh` | 73 | !/usr/bin/env bash |

## Infrastructure & deployment

8 source files · 313 lines

| file | lines | purpose |
| --- | ---: | --- |
| `README.md` | 146 | ClipForge AI |
| `docker-compose.dev.yml` | 226 | Development stack: every service hot-reloads or runs from source, storage is local. |
| `docker-compose.monitoring.yml` | 19 | Optional overlay: use with docker-compose.prod.yml or docker-compose.dev.yml. |
| `docker-compose.prod.yml` | 265 | Production stack: built images, Caddy TLS front door, scheduled PostgreSQL backups. |
| `infrastructure/README.md` | 17 | `infrastructure/` |
| `infrastructure/monitoring/README.md` | 32 | Operational health and optional monitoring |
| `infrastructure/monitoring/alerts.yml` | 16 | — |
| `infrastructure/monitoring/blackbox.yml` | 11 | — |
| `infrastructure/monitoring/prometheus.yml` | 22 | JSON readiness endpoints are HTTP-probed by blackbox-exporter, never parsed as metrics. |
| `infrastructure/scripts/backup-loop.sh` | 8 | !/usr/bin/env sh |
| `infrastructure/scripts/backup-postgres.sh` | 26 | !/usr/bin/env bash |
| `infrastructure/scripts/check_health.py` | 40 | Operator smoke test: HTTP success AND a valid service readiness document required. |
| `infrastructure/scripts/docker-entrypoint.sh` | 9 | !/usr/bin/env sh |
| `infrastructure/scripts/healthcheck.sh` | 5 | !/usr/bin/env bash |
| `infrastructure/scripts/restore-postgres.sh` | 14 | !/usr/bin/env bash |
| `infrastructure/scripts/run-service.sh` | 5 | !/usr/bin/env bash |
| `infrastructure/scripts/verify-pipeline.py` | 206 | End-to-end verification of the AI analysis + video rendering chain. Runs against the real ai-engine and video-processor HTTP services with a real vide |
| `package.json` | 61 | — |
| `tsconfig.base.json` | 22 | — |
| `tsconfig.json` | 1 | — |

## Documentation — `docs`

0 source files · 0 lines

| file | lines | purpose |
| --- | ---: | --- |
| `docs/ADD-API-KEYS.md` | 88 | Adding the API keys later (plain language) |
| `docs/AI-PIPELINE.md` | 93 | AI pipeline |
| `docs/API_CONNECTION_AUDIT.md` | 107 | API connection audit |
| `docs/ARCHITECTURE.md` | 94 | Architecture |
| `docs/ARCHITECTURE_REPORT.md` | 234 | `, `components/**` \| rendering, input format checks, loading/empty/error states, navigation \| secrets, DB access, token refresh, permission decisions  |
| `docs/AUTH-SECURITY.md` | 135 | Account security — second factor, recovery, devices |
| `docs/BACKEND_AUDIT.md` | 131 | Backend audit |
| `docs/CONFIGURATION.md` | 85 | Configuration |
| `docs/DEPLOY-VERCEL.md` | 352 | Deploying ClipForge AI |
| `docs/DOCUMENT-INDEX.md` | 81 | Document index |
| `docs/FIREBASE-AUTH.md` | 286 | Connecting Firebase Auth to ClipForge |
| `docs/FOLDER-STRUCTURE.md` | 187 | Folder structure |
| `docs/FRONTEND_AUDIT.md` | 108 | Frontend audit |
| `docs/IMPLEMENTATION_PLAN.md` | 135 | Implementation plan |
| `docs/IMPLEMENTATION_STATUS.md` | 214 | Implementation status — independent audit round |
| `docs/OPERATIONS.md` | 76 | Operations |
| `docs/PLATFORM-SETUP.md` | 64 | Platform setup (Google / Meta / storage) |
| `docs/PRODUCTION-READINESS.md` | 306 | Production readiness: current engineering run |
| `docs/README.md` | 25 | docs/ — the written record |
| `docs/SECURITY-NOTES.md` | 69 | Dependency security notes |
| `docs/SECURITY_AUDIT.md` | 102 | Security audit |
| `docs/TELEGRAM-AUTH.md` | 76 | Telegram sign-in and bot connection |
| `docs/TELEGRAM-NOTIFICATIONS.md` | 179 | Telegram notifications |
| `docs/TESTING.md` | 136 | Testing |
| `docs/UPGRADE-PLAN.md` | 98 | Upgrade plan — 17 modules, implementation order and honest status |
| `docs/UPLOADS.md` | 28 | Browser uploads |
| `docs/VERIFICATION.md` | 588 | Verification report |
| `docs/WORKSPACE.md` | 28 | What is kept in the workspace |
| `docs/YOUTUBE-IMPORT.md` | 132 | YouTube URL import |
| `docs/authentication-endpoint-diagnostics.md` | 84 | Authentication endpoint diagnostics and repairs — 2026-11-16 |
| `docs/authentication-overhaul.md` | 249 | Authentication hardening — implementation and verification |
| `docs/clipping-engine-phase.md` | 103 | Clipping-engine implementation and evidence |
| `docs/csrf-endpoint-repair.md` | 69 | CSRF endpoint repair — 2026-11-16 |
| `docs/development-auth-bypass.md` | 53 | Temporary local development access |
| `docs/existing-telegram-bot-setup.md` | 134 | Connect an existing Telegram bot to ClipForge |
| `docs/foundation-audit.md` | 322 | ClipForge AI foundation audit and deployment reference |
| `docs/local-startup.md` | 76 | Reliable local API and frontend startup |
| `docs/login-contract-fix.md` | 94 | Telegram login crash and API contract fix — 2026-11-16 |
| `docs/openapi.json` | 1 | — |
| `docs/platform-engineering-ledger.md` | 118 | Platform engineering audit and implementation ledger |
| `docs/production-api-investigation.md` | 137 | Production API/proxy investigation — 2026-11-16 |
| `docs/recovery-repair-evidence.md` | 29 | Recovery repair checkpoint — 2026-11-16 |
| `docs/render-api-production.md` | 189 | ClipForge API: compiled-only production startup on Render |
| `docs/render-local-storage.md` | 130 | Render local storage: exact configuration and serving contract |
| `docs/telegram-bot-only-auth.md` | 231 | Telegram bot-only authentication implementation |
| `docs/typescript-build-toolchain.md` | 184 | Render TypeScript compiler consistency — 2026-11-16 |

---

## Where the work happens

| question | file |
| --- | --- |
| How is a video turned into clips? | `apps/api/src/workers/pipeline.worker.ts` + `services/ai-engine/app/pipeline.py` |
| How are clips rendered? | `services/video-processor/app/renderer.py` (+ `framing.py`, `subtitles.py`, `audio.py`) |
| How are candidates chosen? | `services/ai-engine/app/selection.py` |
| How is publication done? | `apps/api/src/workers/publish.worker.ts` + `packages/platform-connectors/src/` |
| Where is the data model? | `packages/database/prisma/schema.prisma` |
| Where is auth / sessions / CSRF? | `apps/api/src/auth/`, `apps/api/src/common/guards/` |
| Where is cost accounting? | `apps/api/src/common/services/usage-cost.ts`, `apps/api/src/usage/` |
| Where are the end-to-end scenarios? | `tests/e2e/scenarios.py` |
