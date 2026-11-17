# Platform engineering audit and implementation ledger

Date: 2026-11-16. Branch: arena/435740e9-youtubeautomatin.

## Current outcome (latest continuation)

**Not all requested tasks are complete.** Latest checks: full production compilation passed with the sandbox-only engine-free Prisma workaround; **393 unit tests passed, 3 skipped, 55 files passed**; **29 Python tests passed with real FFmpeg, none skipped**; lint passed; **82 structure checks passed**. No schema change, deployment or publication. Concrete additions include lease deferral/ownership, Python media-path boundaries, OAuth redirect sanitization, signed private S3 platform delivery, a database-backed calendar and dashboard presentation. The continuation section below supersedes the initial increment's test counts and missing-FFmpeg limitation. Live integration/native Prisma/recovery fencing/shared Render filesystem/provider/browser release gates remain open.

## Scope and evidence boundary

This is the first hardening increment, not completion of the requested production-readiness programme. Inventory and execution-path inspection are substantial but NOT a complete line-by-line repository audit. No deployment, social account connection, real model inference, public publishing, destructive migration, or provider administration was performed. Telegram-only authentication and existing data/session infrastructure are preserved.

## Before / after architecture

Existing: Next frontend -> same-origin API proxy -> Nest API -> Prisma/Postgres; BullMQ/Redis dispatches pipeline/render/publish/scheduler/recovery workers. Python AI service probes media, transcribes with Whisper, samples scenes and calls Gemini; Python processor runs FFmpeg. Official platform connectors implement YouTube/Instagram publishing. Storage supports local and S3; transactional/outbox/job/schema entities already exist and must be reused.

Before this increment, source detail used a raw storage-key public URL even though the media controller had no wildcard route. Clip S3 URLs assumed public distribution; authenticated media controller explicitly refused S3. After: browser source/clip preview and download use the existing session/workspace-scoped `/media/sources/:sourceId` and `/media/clips/:variantId` routes for both drivers, with private cache policy and existing range delivery. This is authenticated streaming, not a new signed URL implementation. Anonymous Instagram fetch still needs its separate publishing delivery strategy; this change does not solve that release gate.

## Implemented changes / files

- `apps/api/src/sources/sources.service.ts`: source detail returns ID-based media route, not raw key URL.
- `apps/api/src/clips/clips.service.ts`: preview/download use authenticated routes for both drivers; obsolete storage injection removed.
- `apps/api/src/media/media.controller.ts`: existing ownership-checked byte/range streaming now supports S3 as well as local.
- `apps/api/src/common/env.ts`: production Postgres/Redis URL protocols and literal loopback targets rejected without printing credentials. Does not prove DNS/network connectivity or block every possible DNS alias.
- `infrastructure/docker/web.Dockerfile`: copy root TypeScript configuration and shared-types/validation build inputs, retain built packages in runtime image. Docker build itself remains untested here.
- `services/ai-engine/app/config.py`: fixture inference forbidden with NODE_ENV=production or Render runtime marker, even if TEST_MODE=1.
- `infrastructure/docker/ai-engine.Dockerfile`, `docker-compose.*.yml`: propagate explicit runtime environment so production guard is effective; development Compose can still run isolated fixtures explicitly.
- `apps/api/scripts/run-workers.sh`: exhausted restart budget exits nonzero instead of misleading successful shutdown; signal shutdown remains zero.
- `tests/unit/private-media.test.ts`: real Nest HTTP controller with isolated mocked DB/session/storage tests anonymous denial, owned private S3 streaming, ranges, foreign ID/raw-path denial. NOT live S3/DB evidence.
- `tests/unit/source-library.test.ts`, `production-connections.test.ts`, `worker-launcher.test.ts`, `tests/python/test_ai_fixture_guard.py`: regression coverage for changed contracts, configuration, process exit and inference guard.
- `docs/ARCHITECTURE.md`: active Telegram-only auth clarification and evidence link.

No schema/migration changes. No new endpoint. No new environment variable. No provider settings changed. Existing local Render storage instructions remain `docs/render-local-storage.md`: paid persistent disk at `/var/data`, root `/var/data/clipforge/objects`, route base `https://youtubeautomatin.onrender.com/media`. Directory creation is not disk provisioning; API-attached disk is not automatically shared across workers/services.

## Phase ledger (0–13 controlled plan)

Numbers below are an implementation tracking sequence, not a claim that all requested phases have shipped.

| Phase | Area | Current evidence / remaining gate |
|---|---|---|
| 0 | Inventory and dependency map | Routes, packages, schema, services, deployments and selected execution paths inspected; full audit still ongoing |
| 1 | Infrastructure/config | Loopback, Docker inputs, worker exit fixed; real image builds, service boot/readiness and deployment env review pending |
| 2 | Authentication/security | Existing Telegram/session/CSRF/RBAC preserved; targeted private-media ownership tests pass; comprehensive penetration/concurrency review pending |
| 3 | Ingestion/authorized source | Existing metadata/upload/source implementations identified; source URL defect fixed; authorized real upload/resume/probe verification pending |
| 4 | Durable private storage | Both drivers support authenticated playback; live S3, cleanup, disk capacity and distributed filesystem proof pending |
| 5 | Transcription | Real Whisper implementation exists; production fixture prohibition tested; model-backed timestamps not run |
| 6 | Analysis and selection | Gemini/scenes/candidate implementations exist; real inference/quality/configuration verification pending |
| 7 | Rendering | Existing FFmpeg renderer/probe validation exists; binaries unavailable here; real vertical/subtitle/output proof pending |
| 8 | Metadata editing | Existing service/UI contracts found; no redesign or live editing flow verified this increment |
| 9 | YouTube OAuth/publishing | Official connector exists; credentials, resumable upload/processing/idempotency live evidence pending; no publication attempted |
| 10 | Instagram OAuth/publishing | Official connector exists; eligibility/approval/public-fetch and container polling live evidence pending |
| 11 | Jobs/recovery | Supervisor failure fixed/tested; parent render lease contention/ack/recovery path needs deeper tracing and concurrency tests |
| 12 | Frontend | Existing DB hooks/states found; requested premium redesign, calendar and browser acceptance not completed |
| 13 | Release verification | Build/lint/unit checks below pass; integration/native engine/media/provider/deployment acceptance still blocked |

## Integration classifications

- Authenticated media routing / config guards / worker exit: **Implemented and tested** in isolated tests; live infrastructure not verified.
- YouTube official OAuth/upload: **awaiting credentials** for live verification; existing code is not a provider-certified integration claim.
- Instagram official OAuth/Reels: **awaiting credentials** and **awaiting provider approval** where required; app eligibility unverified, not asserted denied or approved.
- Whisper/Gemini end-to-end analysis: **awaiting credentials** and model/runtime dependencies.
- Production-wide E2E acceptance and requested new visual redesign: **not implemented** in this increment.

## Commands and actual outcomes

- `npm ci --ignore-scripts`: passed; deliberately does not prove native install hooks.
- `PRISMA_GENERATE_NO_ENGINE=1 PRISMA_QUERY_ENGINE_LIBRARY=/bin/true PRISMA_QUERY_ENGINE_BINARY=/bin/true PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npm run build`: packages/API/Next compilation passed. Sandbox-only engine-download workaround, NOT a deployment command or Prisma native runtime proof. Later API cleanup rechecked with tsc.
- `npm run lint`: passed (configured web ESLint workspace script).
- `npx tsc -p apps/api/tsconfig.json --noEmit`: passed after final API cleanup.
- `SESSION_SECRET=isolated-unit-test-secret-not-for-production-12345 npx vitest run --config tests/vitest.config.ts`: 50 files passed; 374 tests passed, 3 skipped.
- `python3 -m venv .venv && .venv/bin/pip install -r tests/python/requirements.txt`: passed. No generated environment committed.
- `.venv/bin/python -m unittest discover -s tests/python -v`: 25 tests run, 7 skipped, success (18 executed). Seven real-media tests skipped without FFmpeg. Initial system Python attempt failed for missing FastAPI; corrected with isolated test requirements.
- `.venv/bin/python -m compileall -q services`: passed.
- `npx vitest run --config tests/vitest.integration.config.ts`: FAILED: 4 suites failed, 19 tests skipped; missing `.env`/external service configuration. No secrets supplied or invented, no root .env created. No DB integration success claimed.
- `git diff --check`: passed.

## Next release gates

Trace render parent-lease contention through queue retries/outbox/recovery before patching acknowledgment semantics. Establish an explicit shared WORK_DIR/storage transport topology across API, workers, AI and processor; a Render API-only disk is insufficient. Run native Prisma migrations additively against a disposable authorized Postgres instance; verify existing-user integrity before any release. Run live Redis/outbox/cancellation/concurrency tests, real authorized upload and FFmpeg fixtures, real Whisper/Gemini inference, browser/session/CSRF flows, then provider sandbox or explicitly approved account publication. Inspect Vercel API_INTERNAL_URL build-time proxy target and Render APP_URL/origins/cookies/callbacks without exposing secrets. Do not substitute successful compilation, mocks, or public probe health for these gates.

## Continuation increment — 2026-11-16

The user requested continued implementation. The programme remains incomplete; the following additional code was implemented and verified rather than relabeling blocked release gates.

### Additional issues fixed

1. **Lost render/pipeline deliveries under lease contention.** Existing handlers returned success when another handler held the parent lease. They now move the BullMQ job to delayed and throw its `DelayedError` sentinel; terminal/missing deliveries are acknowledged safely. A dedicated AsyncLocalStorage scope creates a unique owner per delivery, including concurrent jobs within one process. Lease acquisition no longer allows same-owner reacquisition and excludes FAILED parents; handler release predicates on owner so an old handler cannot release a newer owner's lease. Shared logs recognize deferral as scheduling rather than a processing failure. Files: `workers/lease-contention.ts`, `workers/{base,pipeline.worker,render.worker}.ts`, `packages/database/src/repositories.ts`; regression tests `lease-contention.test.ts` and `repository-leases.test.ts`. Actual Redis/concurrent DB integration remains unverified; recovery sweep/state-transition fencing needs further work.
2. **Unbounded filesystem RPC paths.** Both Python services now reject relative/URL/traversal paths and symlinks resolving outside WORK_DIR before subprocess/inference. Input files must exist. Optional branding assets and render output are checked too. Shared helper is `services/media_paths.py`, explicitly copied into both Docker images. Tests include real HTTP rejection before inference/probe. This does not protect against a privileged local actor racing symlink replacement; work volumes remain trusted infrastructure. WORK_DIR must be an identical absolute mount across services.
3. **OAuth exception disclosure in redirect URLs.** Account callbacks now return stable `authorization_denied`/`connection_failed` reasons instead of provider descriptions or exception text that could contain tokens/connection strings. Responses set no-store and no-referrer. Existing state verification remains unchanged. Test: `oauth-redirect-security.test.ts`.
4. **Missing content calendar.** Added `/calendar` backed by the existing `/api/publishing/jobs` endpoint, not a duplicate scheduler. Schedule filters require paired, valid date boundaries and a positive window at most 93 days; both rows and count are workspace-scoped and sorted deterministically. Calendar supports month navigation, browser timezone, today's date, loading/error/retry/empty states and explicit pagination at 100 jobs/page; UI clearly states when only one page is displayed. Existing clip publish dialog still performs scheduling. Files: `publishing/publishing-query.ts`, existing controller/service, `web/app/calendar/page.tsx`, `web/lib/calendar.ts`, hooks/shell/publishing page. Tests: `publishing-calendar.test.ts`. Browser interaction acceptance against a live DB remains pending.
5. **Dashboard presentation.** Added a responsive workspace hero consistent with the existing login visual treatment, actual database counts and working Create/Calendar navigation. No fabricated metrics. This is an incremental improvement, NOT completion of a full reference-design/browser audit.
6. **Private platform delivery and incorrect YouTube prerequisite.** S3 objects can now be handed to Instagram with an actual AWS SDK presigned GET capability (default one hour, allowed 60 seconds–24 hours), generated only for an authorized publishing attempt. Bucket public access is no longer necessary. Local session routes correctly fail Instagram fetch capability checks. YouTube uploads bytes and no longer incorrectly requires public storage to enable publishing. `expectPublicHttps` now describes configuration capability, not a network/object-fetch proof. Files: storage service, publishing service, publish worker; `signed-media.test.ts` uses real signing with isolated test keys and no network. No signed URLs are added to browser responses. Live provider fetch, temporary credential expiry and processing timing still require verification.

### Fresh verification

- Full sandbox engine-free production build: passed after lease/calendar/dashboard changes, including `/calendar`. Subsequent signed-delivery/API changes passed API `tsc --noEmit` and targeted tests; final suite results below supersede earlier counts.
- Full unit suite before signed-delivery additions: **388 passed, 3 skipped, 54 files passed**.
- Signed-delivery targeted tests: **4 passed**, including real local SDK signing, bounded expiry, invalid keys, local/HTTP denial.
- Web lint passed after calendar/dashboard changes.
- Production Python 3.13/PyAV concern investigated: `pip download --only-binary=:all: --no-deps --python-version 313 --implementation cp --abi cp313 --platform manylinux_2_17_x86_64 av==13.1.0` succeeded. No unproven Python downgrade was made; this is wheel availability, not a Docker image build.
- Real FFmpeg tools became available for testing: downloaded `ffmpeg-binaries==1.1.0` from PyPI into temporary storage, extracted only ffmpeg/ffprobe into ignored `.venv/bin`; version reports **6.0-static**. No binary/package added to Git or production requirements. This test tool version is not a claim about production's distro FFmpeg.
- `PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -m unittest discover -s tests/python -v`: **29 tests passed, zero skipped**. Includes existing real encoded media rejection tests and new `test_render_http.py`: generates moving synthetic source+tone, calls real HTTP `/render`, burns supplied timed fixture words, renders 202×360 vertical H.264/AAC, validates duration/codecs/audio/content and asserts output bytes. This proves the render path on synthetic fixtures, NOT genuine Whisper timestamps, Gemini quality, or a full platform workflow.

### Supported deployment topology / remaining production blockers

- **Single-host Docker Compose:** `docker-compose.prod.yml` explicitly mounts `work-data:/data/work` on API, pipeline/render workers, AI and video processor, and local storage on the relevant byte-store consumers. This is the existing supported filesystem topology to verify on a Docker-capable host. Run `docker compose -f docker-compose.prod.yml config --quiet`, then authorized image builds/start and workflow tests. Docker is unavailable in this sandbox; no image/start claim is made.
- **Split Render services:** `render.pipeline.yaml` remains NOT sufficient proof of a functioning pipeline. Separate Render service disks are not a shared WORK_DIR. Private S3 solves durable object storage, not current path-based Python RPC materialization. Do not deploy that blueprint expecting cross-service file paths to work without shared-volume infrastructure or a separately implemented authenticated object-transfer transport. Existing Render API-only setup can serve auth/dashboard/private media with its persistent disk but is not the complete processing stack.
- **Native/database integration:** no DATABASE_URL/REDIS_URL/provider configuration or root .env was supplied; no disposable DB exists here. Earlier integration failures remain unresolved. No production migrations/resets or user deletions occurred; no schema change is required for this increment.
- **Provider operations:** no login webhook registration, OAuth exchange, model download/inference, or social publication occurred. Genuine timestamp transcription, account eligibility/approval, resumable upload/container reconciliation under timeouts, and live scheduled publishing are still release gates.
- **Scope still unfinished:** complete line-by-line security/architecture review, race-fenced recovery/state transitions, comprehensive cleanup/retention/capacity guarantees, full premium frontend interaction/browser acceptance, real Vercel→Render deployment verification and non-destructive existing-data integration evidence.


### Final continuation checks

- `SESSION_SECRET=isolated-unit-test-secret-not-for-production-12345 npx vitest run --config tests/vitest.config.ts`: **393 passed, 3 skipped, 55 files passed** after all signed-delivery/platform-specific tests.
- Full `npm run build` with the previously documented sandbox-only Prisma engine variables: **passed after all application changes**, packages/API/Next including calendar.
- `npm run verify:structure`: **82 passed, zero failed** after indexing this report.
- `git diff --check`: passed. Native Prisma/Postgres/Redis and deployed provider tests remain unverified, not silently skipped as successful.
