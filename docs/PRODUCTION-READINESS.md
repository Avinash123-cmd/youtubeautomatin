# Production readiness: current engineering run

Date: **2026-11-16 (UTC)**. This is current-session evidence, not a restatement of older audits.
The mission is **not complete**: the full production definition of done has not been demonstrated.
Older verification documents refer to a different environment and are not current release evidence.

## Dependency map and audit scope

```
Browser → Next app /api & /media rewrites → Nest controllers
  → session/RBAC → Redis throttling → CSRF → Zod/domain services
  → workspace-scoped Prisma queries → PostgreSQL (durable source of truth)
  → storage (local or S3 multipart; workspace media keys)
  → transaction outbox → BullMQ/Redis
    → pipeline worker → AI FastAPI (FFprobe/audio/Whisper/Gemini/selection)
    → render worker → video FastAPI (framing/ASS captions/FFmpeg/validation)
      → validated artifact → storage + clip variant → publishing outbox
    → publish worker → YouTube/Instagram connectors → platform confirmation
    → scheduler/recovery → leases, retries, scheduling, retention, health snapshots
  → in-app/Telegram notification records and delivery
```

Inspected the application/module graph, auth, system/diagnostics, upload/controllers and services,
clip/metadata surface, queue registry/outbox, worker runtime/render orchestration, Python service
entrypoints/configuration/pipeline/framing/renderer, Prisma schema/migrations, Compose/Docker/service
launchers, monitoring, existing audits and test runners. This is a focused architecture/security/
reliability pass, **not an exhaustive line-by-line audit of every module or dependency CVE**.

No parallel authentication system, schema reset, mock dashboard, fake processing endpoint, new AI
provider or unnecessary frontend rewrite was introduced. Existing UI pages call real hooks/API
routes; this run did not exhaustively browser-test every page.

## Implemented changes and their verification boundary

### Foundation and observability

- Distinct API `/api/system/live` and Python `/live`: process liveness only.
- API `/api/system/health`: database schema query and Redis PING; **503** on failure rather than 200.
  Public checks omit exception messages/driver details. Full details stay on authenticated diagnostics.
- Public `/api/system/readiness` preserves component statuses without driver messages, host/path
  details or worker IDs. Returns 503 for unavailable core dependencies.
- Processing readiness now requires AI/render/recovery heartbeats, not merely running HTTP servers.
  Publishing prerequisites require publish/scheduler/recovery and a configured platform. This is
  configuration/presence readiness, not proof remote credentials are accepted or a post can publish.
- HTTP probe deadlines; bounded database/Redis/storage waits; no full-table COUNT for database health.
  The database probe verifies an application table exists but does not replace migration deployment.
- Unique storage probe keys avoid concurrent deletion races; cleanup is attempted on failure.
- Worker discovery uses bounded SCAN/MGET, ignores corrupt records and future timestamps, and a
  discovery outage degrades readiness rather than throwing a generic error.
- Python health returns 503 when tool/config prerequisites are missing. Video health checks actual
  subprocess exit codes, not just presence of stdout. AI reports modelLoaded; it does not load/download
  a model or call a remote provider during every probe. Fixture mode is not production-ready in Nest.
- Web `/healthz` no longer reports success for an unrelated HTTP-200 origin.
- Shell smoke check validates HTTP **and JSON readiness**, without jq. Failure returns nonzero.
- Corrected Prometheus JSON scraping: blackbox exporter now produces actual readiness metrics;
  alert rules use probe_success/up. Removed nonexistent queue metric alert. Optional monitoring
  overlay added; Alertmanager and operational alert delivery remain unconfigured.

**Verified:** TypeScript readiness/helper/controller tests and Python TestClient tests; actual Python
launcher startup/shutdown and HTTP probes without prerequisites. Docker/Prometheus execution blocked.

### Security and data integrity

- Prior auth work remains: deterministic root env, strict origin policy and 403s, full CSRF, provider
  OTP enforcement, one-time bot links, atomic OTP/DUAL policy, encrypted provider handoff and sessions.
  See [authentication-overhaul.md](authentication-overhaul.md).
- Redis rate limiting uses one Lua operation for INCR/expiry and repairs a counter lacking TTL.
  API Redis requests have bounded retries/timeouts; workers retain dedicated blocking-compatible clients.
- Diagnostics stuck processing/publishing queries and source/variant integrity samples now enforce
  workspace scope. This closes a record/key disclosure between workspace owners. Fixed lease-seconds
  to milliseconds conversion in stuck-job detection.
- Service-to-service keys use constant-time comparison in both Python services.
- AI HTTP job IDs cannot traverse the work directory; candidate/clip counts and score thresholds bounded.
- Video render HTTP input rejects nonfinite values, invalid time windows, odd/invalid dimensions,
  and out-of-range fps/bitrate before spawning FFmpeg.
- Node render client runtime-validates Python's success report. Nonempty validationErrors, invalid
  dimensions/empty files/incomplete reports or HTML-200 responses cannot proceed to READY/storage.

**Verified:** isolated repository/HTTP/contract tests. Redis Lua execution, transaction concurrency,
complete tenancy matrix and live render output remain release gates, not claimed passes.

### Operational lifecycle

- Python launcher now resolves the repo from script location, loads root .env using native Node
  parsing without overwriting injected variables, supports PYTHON_BIN, validates service/port and
  forwards shutdown signals. Removed hardcoded `/home/user/clipforge-ai` path.
- Worker shutdown is idempotent and has a configurable deadline. Dedicated Redis producer clients
  disconnect after worker closure. Interrupted leases are left for normal recovery, never marked done.
- Compose workers get a 45s stop grace period, longer than the default 30s application drain deadline.
  If changing WORKER_SHUTDOWN_GRACE_MS, keep it below the container/platform stop grace period.
- Test Python command discovers both media validation and service HTTP tests.
- E2E requires explicit disposable credentials and a supplied speech-bearing video, not hardcoded
  demo credentials or a nonexistent machine-specific path.
- Structure check understands the optional monitoring overlay and no longer requires ignored,
  regenerated screenshots to exist on a fresh checkout. Documentation index repaired.

**Verified:** launcher subprocesses and clean exits; typechecks for worker changes. Worker/BullMQ
runtime shutdown and Compose behavior still require live Redis/PostgreSQL/Docker testing.

## Frontend-to-pipeline integration fixes

- Fixed the Create project upload/import request: it sent `{sourceId}` without configuration, but
  the API requires `{sourceVideoId, configuration}`. The web now uses the shared Zod contract and
  saved framing/subtitle/quality settings; it validates settings before uploading bytes.
- Added explicit 15s/30s selection and review-only publishing behavior to that screen.
- Fixed rights attestations: short enum codes (notably I_OWN_THE_CONTENT) could fail the API's
  minimum statement length. The UI now submits full attestations accepted by upload and import schemas.
- Added `/videos`: paginated real source queries, filename search, validation filter, stable sorting,
  metadata/unknown states, validation failures, source previews and Generate clips through the real
  job endpoint. New sources navigation item. No mock records or fabricated processing progress.
- `/api/sources` now validates search/status/sort and scopes both list and count to the workspace.
- Concurrent job creators now lock the source and recheck active jobs/source validity inside the
  transaction before writing the job/outbox. This supplements, rather than trusts, preflight checks.

**Verified:** shared request/rights schemas, source query scoping/pagination, duplicate-creator
transaction guard tests, TypeScript, lint and production app build. Actual video upload and a real
PostgreSQL race remain blocked. Source deletion and persistent multipart recovery UI are not delivered.

## Product capability classification

A = implemented and tested **at the stated boundary**, B = external credentials required,
C = partial, D = not implemented, E = blocked verification dependency. Categories can coexist.

| Capability | Classification and current evidence |
|---|---|
| Env/origin/CSRF/auth policy | A (unit + isolated Nest HTTP); E for real DB bootstrap/session workflows |
| Google and Telegram OIDC | B/E; signature/policy/cookie tests pass, no live provider exchange |
| Bot linking/OTP/notifications | A (stubbed boundary tests), B/E for real Telegram delivery |
| Database migrations | Existing schema and migrations retained; no new migration; E for deploy |
| PostgreSQL/Redis connectivity | E; no configured PostgreSQL/Redis or Docker in this sandbox |
| Dashboard/counts/activity/usage | Existing database-backed implementation; E for current live verification |
| Upload/chunking/validation | Existing implementation with workspace queries; E for live storage/video flow |
| Video library | A at query/schema/build boundary; new search/filter/sort/pagination/preview/reuse UI. C for deletion and persistent upload recovery; E for live database/browser workflow |
| AI transcription/highlight/ranking | Existing Gemini/Whisper pipeline; B/E for credentials/models/media tools |
| Provider modularity | C; explicit Gemini + isolated test fixture, not interchangeable production providers |
| Speaker diarization | D; do not advertise unsupported speaker identification |
| Render/captions/branding/quality gate | A for parser/contract/input checks; E for actual FFmpeg verdict/render tests |
| 9:16, 16:9, 1:1 export profiles | C; current renderer validates 9:16; landscape/square not delivered |
| Interactive video timeline/caption editor | D; metadata editor/preview exist, not full timeline editing |
| Clip export/download | Existing media/variant implementation; E for current end-to-end media verification |
| YouTube/Instagram OAuth/publishing/retries | B/E; existing connectors, no live account/post in this run |
| Scheduling | Existing scheduler worker; E for live queue/calendar behavior |
| Engagement metrics/report exports | C/D; processing/usage counts exist, requested remote metrics/reports incomplete |
| Profile/workspace/team invitations | C/D; workspace settings exist, full team-management product incomplete |
| Billing/subscriptions/plan enforcement | D; usage data is not a payment/subscription implementation |
| Premium light/dark dashboard | C; existing responsive light UI/auth panels preserved; dark theme not added |
| Health/diagnostics | A at isolated HTTP and launcher boundaries; E for complete live dependencies |
| Monitoring/backup/restore | C/E; optional corrected monitoring and existing scripts, no Docker/restore drill |

## Configuration and startup

Existing required settings remain in `.env.example`. Additional optional settings:

```dotenv
HEALTHCHECK_TIMEOUT_MS=5000
WORKER_SHUTDOWN_GRACE_MS=30000
```

Node 20.12+ is required for native dotenv loading. No credentials or local .env were created.

```sh
# After filling root .env and provisioning services:
npm ci
npm run db:generate
npm run build:packages
npm run db:deploy
npm run dev:api
npm run dev:web
# Separate terminals; pinned service dependencies must be installed in .venv:
bash infrastructure/scripts/run-service.sh ai-engine 8100
bash infrastructure/scripts/run-service.sh video-processor 8200
# Each role separately, or the existing worker supervisor:
bash apps/api/scripts/run-workers.sh
npm run verify:health
```

Alternatively use `docker compose -f docker-compose.dev.yml up --build`; enable the monitoring
overlay as documented in `infrastructure/monitoring/README.md`. Backups/restore procedures remain
in [OPERATIONS.md](OPERATIONS.md); perform a restore drill before relying on them in production.

## Current-run evidence and release blockers

- Unit suite: **205 tests / 28 files passed**, using a non-production test SESSION_SECRET.
- Backend/frontend TypeScript and ESLint passed. `npm run build:apps` passed API + Next production builds, including `/videos`. `npm run verify:structure`: 79 checks passed.
- Python unittest: **23 discovered, 16 passed, 7 skipped** (FFmpeg verdict tests lack ffmpeg/ffprobe).
- Actual Python processes: both `/live` → 200; AI `/health` → 503 unconfigured; video `/health` → 503
  missing tools. Smoke check correctly exited 1. Both stopped cleanly. No healthy full stack claimed.
- Integration suite attempted: **4 failed suites, 19 skipped tests**, root .env/DB/native runtime absent.
- E2E attempted: failed preflight (no supplied video/full-stack credentials); no workflow pass.
- Prisma schema validation previously passed; deployment/migration execution still blocked.
- Docker/Compose/Prometheus execution not available. Corrected YAML is not a container smoke test.
- Full `npm run build` was attempted and failed during native Prisma engine download, blocked by sandbox host restrictions. Existing engine-free
  generated types enable compilation only; they are not a working local PostgreSQL client.

Before release, provision PostgreSQL/Redis/media tools/model cache/storage/credentials; regenerate
normal Prisma client and deploy migrations; run actual workspace authorization tests, queue retries/
crash recovery, source upload→Whisper/Gemini→validated render→download, provider auth/bot OTP,
publishing against test accounts, backup/restore, load testing and Docker shutdown drills.

The advanced editor, billing/team features, multi-provider AI and additional export profiles require
further product work; they cannot be declared complete by passing foundation tests.

## Repeatable local verification

```sh
SESSION_SECRET=unit-test-only-secret-at-least-32-characters npx vitest run --config tests/vitest.config.ts
npm run typecheck -w @clipforge/api
npm run typecheck -w @clipforge/web
npm run lint
python3 -m venv .venv
.venv/bin/pip install -r tests/python/requirements.txt
npm run test:python
npm run verify:structure
npm run build:apps
```

For real rendering, install ffmpeg AND ffprobe and set the service paths. For full integration/E2E,
use a disposable database and a complete root .env, then run `npm run test:integration` and
`npm run test:e2e` with CLIPFORGE_TEST_VIDEO/CLIPFORGE_EMAIL/CLIPFORGE_PASSWORD explicitly supplied.
The Python test dependency list intentionally excludes model weights; test HTTP boundaries are not
Whisper inference. Synthetic secrets in the test command must never be used for deployment.

## Cumulative branch changed files (includes preceding auth work)

- `.env.example`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/otp.service.ts`
- `apps/api/src/auth/pending-step-up.ts`
- `apps/api/src/auth/security.controller.ts`
- `apps/api/src/auth/security.service.ts`
- `apps/api/src/auth/session.service.ts`
- `apps/api/src/auth/telegram-account.service.ts`
- `apps/api/src/common/env.ts`
- `apps/api/src/common/filters/all-exceptions.filter.ts`
- `apps/api/src/common/health-probe.ts`
- `apps/api/src/common/origin-policy.ts`
- `apps/api/src/common/services/redis.service.ts`
- `apps/api/src/jobs/jobs.service.ts`
- `apps/api/src/load-env.ts`
- `apps/api/src/main.ts`
- `apps/api/src/sources/sources.controller.ts`
- `apps/api/src/sources/sources.service.ts`
- `apps/api/src/system/diagnostics.service.ts`
- `apps/api/src/system/system.controller.ts`
- `apps/api/src/system/system.service.ts`
- `apps/api/src/workers/base.ts`
- `apps/api/src/workers/services-client.ts`
- `apps/web/app/create/page.tsx`
- `apps/web/app/healthz/route.ts`
- `apps/web/app/login/page.tsx`
- `apps/web/app/register/page.tsx`
- `apps/web/app/security/page.tsx`
- `apps/web/app/videos/page.tsx`
- `apps/web/components/shell.tsx`
- `apps/web/lib/api.ts`
- `apps/web/lib/hooks.ts`
- `apps/web/lib/processing-request.ts`
- `apps/web/lib/source-rights.ts`
- `apps/web/package.json`
- `docker-compose.dev.yml`
- `docker-compose.monitoring.yml`
- `docker-compose.prod.yml`
- `docs/DOCUMENT-INDEX.md`
- `docs/FOLDER-STRUCTURE.md`
- `docs/PRODUCTION-READINESS.md`
- `docs/authentication-overhaul.md`
- `infrastructure/monitoring/README.md`
- `infrastructure/monitoring/alerts.yml`
- `infrastructure/monitoring/blackbox.yml`
- `infrastructure/monitoring/prometheus.yml`
- `infrastructure/scripts/check_health.py`
- `infrastructure/scripts/healthcheck.sh`
- `infrastructure/scripts/run-service.sh`
- `package-lock.json`
- `package.json`
- `packages/validation/src/index.ts`
- `scripts/check-structure.sh`
- `scripts/run-python-service.cjs`
- `services/ai-engine/app/main.py`
- `services/video-processor/app/main.py`
- `tests/README.md`
- `tests/e2e/full_workflow.py`
- `tests/python/requirements.txt`
- `tests/python/test_service_health.py`
- `tests/unit/auth-security.test.ts`
- `tests/unit/diagnostics-isolation.test.ts`
- `tests/unit/job-create-idempotency.test.ts`
- `tests/unit/load-env.test.ts`
- `tests/unit/origin-csrf.test.ts`
- `tests/unit/otp-lifecycle.test.ts`
- `tests/unit/pending-step-up.test.ts`
- `tests/unit/provider-step-up.test.ts`
- `tests/unit/redis-rate-limit.test.ts`
- `tests/unit/service-contracts.test.ts`
- `tests/unit/session-validation.test.ts`
- `tests/unit/source-library.test.ts`
- `tests/unit/step-up-policy.test.ts`
- `tests/unit/system-readiness.test.ts`
- `tests/unit/telegram-linking.test.ts`
- `tests/unit/web-auth-api.test.ts`
- `tests/unit/web-processing-request.test.ts`

## Telegram-only cutover supersedes prior auth-provider status

See [telegram-bot-only-auth.md](telegram-bot-only-auth.md) for the current active module, migration, test evidence and A–F release gates. Legacy password/Firebase/OIDC/recovery controllers are no longer registered. This cutover is not declared production-ready: real-bot authentication and database migration/concurrency remain unverified.
