# ClipForge AI foundation audit and deployment reference

Date: 2026-11-16. Branch: `arena/435740e9-youtubeautomatin`. Target: `main`.

## Release verdict

**Code hardening is implemented; production acceptance is BLOCKED, not complete.** A working deployment cannot be certified without native Prisma engines, an authorized PostgreSQL/Redis/storage environment, deployment access and live Telegram session verification. Remaining dependency advisories and the split-service media filesystem topology are explicit release risks. No production data was changed, no migrations applied, no provider accounts connected and no publication performed.

This report supersedes older documentation that describes password, Firebase, Telegram OIDC, anonymous local storage, or the free Render template as production-ready. Historical implementation files remain for migration/reference; they were not deleted merely for appearing unused. The previous broader task's calendar/dashboard work is preserved in its separate commit; **this foundation pass adds no redesign or AI functionality**.

## Audit inventory and architecture

Inventory at the start of this pass: 374 tracked files, root plus six npm workspaces, eight TypeScript configurations, 16 controller source files (two explicitly retired), ten Prisma SQL migrations. Inspected manifests/lock/compiler resolution; module/controller/provider wiring; Prisma schema/migrations/client/crypto; Redis/queue/outbox/worker lifecycle; Python entrypoints/path authentication/rendering; storage/upload/media delivery; Telegram/session/CSRF/origin guards; frontend proxy/clients/health; Render/Vercel/Docker settings; tests and deployment documentation. This is an execution-path and configuration audit, **not a claim of exhaustive line-by-line review or penetration certification**.

```text
Browser: youtubeautomation-mauve.vercel.app
  Next.js 15 / React 19 / React Query
  relative /api/* and /media/* requests, same-origin HttpOnly cookies
    |
    | build-time Next rewrites (API_INTERNAL_URL > committed api-target.json)
    v
NestJS API: youtubeautomatin.onrender.com (Node 22 native, or Docker Node 20)
  environment/origin/crypto validation
  one global Prisma lifecycle owner -> PostgreSQL + application-schema probe
  Redis client + subscriber -> rate limiting / queues / transient state
  local persistent disk OR private S3/R2 -> actual byte readback probe
  Telegram-bot-only login -> opaque DB-backed sessions + CSRF + workspace role checks
  controllers: sources/jobs/clips/accounts/publishing/configuration/system/usage/notifications
    |
    + PostgreSQL: users/workspaces/members/sessions/accounts/encrypted OAuth credentials,
    | sources/media/jobs/stages/transcripts/candidates/clips/publishing/outbox/audit
    |
    + transactionally persisted outbox -> scheduler -> BullMQ/Redis
        pipeline -> Whisper/Gemini AI service
        render -> FFmpeg processor -> private objects -> user review
        publish -> official YouTube/Instagram connectors (explicit authorization required)
        scheduler + recovery -> relay / maintenance / retry

Media RPCs currently pass absolute filesystem paths.
API + processing workers + Python services must share WORK_DIR at the SAME path.
S3 object durability does NOT automatically make those local paths shared.
```

### Workspace contracts

- Root: pinned TypeScript **5.9.3**, root `$typescript` override, Node >=20.12/npm >=10. `.node-version` is 22.22.3. No compiler/module-resolution migration is necessary: the removed node10 option is avoided by retaining the known-compatible compiler.
- `@clipforge/shared-types`: shared states/config/contracts, built before validation.
- `@clipforge/validation`: Zod schemas and wire validation; prebuild builds shared-types.
- `@clipforge/platform-connectors`: official API clients; not alternate sign-in providers.
- `@clipforge/database`: Prisma 6.2.1 schema/generated client, repositories/outbox/crypto/configuration.
- `@clipforge/api`: Nest build to `apps/api/dist/main.js`; `start:prod` runs compiled JS, no watcher or startup compilation.
- `@clipforge/web`: Next build; compiled `/api` and `/media` rewrites, backend-down diagnostics.
- Python services: FastAPI API-key-protected media RPCs, real Whisper/Gemini/FFmpeg implementations; fixtures restricted to isolated test mode and forbidden in production.

## Confirmed findings and fixes

| Finding / root cause | Implemented correction | Verification / limitation |
|---|---|---|
| Local-storage boot error is the real env validation guard, not TS5108 | Keep strict guard; exact disk config below, private S3 alternative documented | Driver tests and env tests; no Render disk was provisioned |
| Local raw-key URLs had no real route; S3 preview assumed public objects | Previous commit uses ID-based session/workspace-protected media routes for both drivers | Nest HTTP ownership/range tests, local filesystem tests |
| Vercel deployed build still targeted `api-not-configured.invalid` | Committed fallback now the supplied `https://youtubeautomatin.onrender.com`; validate origin shape, credentials/query/path, hosted HTTPS and loopback | Origin unit tests and hosted-build rewrite inspection; Vercel must redeploy; its env override still wins |
| Prisma lifecycle registered separately by eight feature/root modules against one shared client | One global DatabaseModule/PrismaService lifecycle owner; feature modules reuse it | TypeScript/module graph and startup-path tests |
| Prisma connect had no bounded application-schema readiness probe | Deadline-bound connect + read-only query of ProcessingJob; actionable sanitized startup error | Success/failure/timeout tests; live DB not available |
| Redis construction did not prove connectivity; API could listen while Redis was down | Both command and subscriber clients must PING/PONG before init succeeds; bounded shutdown forces disconnect | Redis initialization/shutdown tests; no live Redis supplied |
| Storage construction/HEAD did not prove bytes readable | Startup and health write unique probe bytes, stream/compare actual readback, then clean probe | Corrupt-readback/cleanup tests and actual local adapter tests; no live S3 supplied |
| Core `/health` omitted critical storage state | DB, Redis AND storage determine core health; unavailable dependency returns 503 | Health unit tests; public response strips internal messages/details |
| Startup notifications raced initialization and leaked raw Prisma error text | Retry starts at application bootstrap after dependency init; sanitized startup warning | Source/runtime negative-start trace; no outbound notifications sent |
| Request completion logging used originalUrl, which includes OAuth code/state query strings | Log request.path, not originalUrl | Source contract test; callback query secrets excluded |
| Fatal startup logging printed arbitrary driver stack/cause | Dedicated StartupDependencyError with static guidance; generic fallback for unknown errors | Credential-redaction tests; actual production command fails nonzero before listen with unavailable dependencies |
| Production accepted malformed AES key, relative work/disk path, mismatched frontend origin/timezone | Production 32-byte base64 key validation; absolute paths; origin-only APP_URL + allowlist inclusion; IANA TIMEZONE validation | Production-shaped env acceptance/rejection tests; existing encryption keys must be preserved |
| S3 SDK pulled a critically vulnerable XML parser | Targeted same-major AWS SDK pins 3.709.0 -> 3.1170.0; no technology/compiler replacement | SDK types/signature tests and full build; native/live S3 still pending |
| Nest adapter retained vulnerable Multer 1.x despite direct Multer 2.x | Direct and overridden transitive Multer 2.5.0; lockfile reconciled and clean install verified | Actual Nest FileInterceptor upload/invalid-field HTTP tests |
| New parser message was not recognized by Nest 10 message-based translation | Global filter handles MulterError type/code with safe 400/413 instead of a leaked/raw 500 | Regression caught during testing and corrected |
| Render default template had old frontend origin, ephemeral permanent video store, misleading optional-auth configuration and generated encryption key of unspecified format | Correct confirmed frontend origin; durable S3 inputs; Telegram-only required auth; externally supplied existing/base64 AES key; controlled migrations | Configuration review; provider settings not changed |
| `.env.example` duplicated upload size and advertised nonexistent AI_ENGINE_WORK_DIR/META webhook key | Remove duplicate and unconsumed examples after repository reference search; keep actual WORK_DIR and callback names | Reference search; no application files removed |

## Storage: actual contract

Accepted drivers are **exactly `local` and `s3`**. No fallback. There is one existing StorageService; no duplicate adapter or static-public route was added.

### Preferred production storage: private S3-compatible bucket

Set `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; supply `S3_ENDPOINT` for R2/custom S3. AWS S3 can omit the endpoint. `S3_FORCE_PATH_STYLE=true|false` depends on the provider. Use HTTPS for platform fetch. Grant narrowly scoped Put/Get/Delete and multipart permissions for this bucket. Browser multipart upload also needs bucket CORS allowing the frontend's exact origin, PUT and required headers/ETag exposure. `UPLOAD_PART_SIZE_MIB` is 5–64 for S3 (default 16). Account for short-lived credential expiry when using signed URLs.

Source buckets remain private. Browser preview/download goes through `/media/sources/:sourceId` and `/media/clips/:variantId`, with session/workspace authorization and ranges. Instagram receives a bounded signed GET URL only during an authorized publish attempt. YouTube uploads bytes. `S3_PUBLIC_BASE_URL` / legacy `STORAGE_PUBLIC_BASE_URL` are optional legacy distribution settings, not prerequisites for private preview/signed publishing.

### Retained local option: paid Render Persistent Disk

Existing API only, attach a paid persistent disk at **`/var/data`**. Configure:

```dotenv
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=/var/data/clipforge/objects
STORAGE_LOCAL_PUBLIC_BASE_URL=https://youtubeautomatin.onrender.com/media
```

The adapter recursively creates missing root/parent directories on write; startup now verifies actual readback. This does not provision a disk or fix mount permissions. Only files under the mounted directory persist. `/tmp`, a free Render service's filesystem, and an unmounted `/var/data` directory are NOT permanent video storage. Verify the mount in the provider settings; merely creating a directory proves nothing about durability.

`/media/health/probe.mp4` is the real embedded public network probe. **`/media/<storage-key>` does not exist.** Private ID routes require authentication; no wildcard/static directory is exposed. The environment variable's historical “PUBLIC” name does not authorize making user media public. Local storage cannot supply Instagram an anonymous fetch URL. See `render-local-storage.md` for mount sizing/operations.

An API-attached Render disk is not shared across separate worker/Python services. Use the existing single-host `docker-compose.prod.yml` shared `work-data:/data/work` topology for path-based processing, or implement/verify an authenticated object-transfer topology before using split services. `render.pipeline.yaml` now explicitly warns of this blocker.

## Startup, readiness and shutdown

Nest creates modules, then initialization hooks verify critical dependencies before `listen` succeeds. A failed DB/schema, Redis PING, or storage readback check aborts startup. `HEALTHCHECK_TIMEOUT_MS` defaults to 5000 per dependency; cleanup can take another bounded interval. Probe deadlines bound the wait, not every underlying driver operation; shutdown has an outer deadline and disconnects resources. Notifications retry only after initialization hooks succeed.

- `GET /api/system/live`: process liveness only, public; not a DB/storage/provider readiness assertion.
- `GET /api/system/health`: public sanitized core DB/Redis/storage conditions; 503 if unhealthy, no-store.
- `GET /api/system/readiness`: sanitized core readiness plus separate processingReady/publishingReady flags and worker roles. Core-ready 200 does NOT mean AI or publishing is ready.
- `GET /api/system/worker-status`, `/queue-status`, `/overview`: authenticated OWNER/ADMIN operator surfaces; live Redis/DB data, not sample counts.
- Redis API clients: 5s connect/command timeouts, two retries per request, ready checks and reconnection; worker blocking connections retain their distinct BullMQ-compatible policy. Configure provider Redis **noeviction** and appropriate durable persistence, not an expiring demo cache.
- Postgres: managed reachable hostname, provider TLS requirements, appropriate pool/connect settings in DATABASE_URL; validate applied migrations. Startup performs only a read query, never a reset/migration.
- Production literal localhost/127.0.0.0/8/unspecified/IPv6 loopback database and Redis targets are rejected. This is configuration validation, not DNS/network reachability certification.

## Production environment reference (A–J)

Do not put secrets into Git, frontend `NEXT_PUBLIC_*`, logs or chat. Configure them in Render/Vercel secret stores. Preserve SESSION_SECRET and CREDENTIAL_ENCRYPTION_KEY for existing sessions/credentials; coordinate any rotation with an explicit migration plan.

| Group | Exact variables and expected format |
|---|---|
| **A API startup** | `NODE_ENV=production`; `APP_URL=https://youtubeautomation-mauve.vercel.app` (origin only); `ALLOWED_ORIGINS=https://youtubeautomation-mauve.vercel.app` (comma-separated trusted exact origins or supported narrowly scoped HTTPS subdomain patterns, not `*`); `TIMEZONE=Asia/Kolkata` or valid IANA name; absolute `WORK_DIR`; `SESSION_SECRET` >=32 chars; `CREDENTIAL_ENCRYPTION_KEY` base64 of 32 bytes; all B/C and one D driver group; E production Telegram trio; current schema also requires service URL/key fields in F/G even when those services are not reachable. Do not fabricate reachable services. |
| **B database** | `DATABASE_URL=postgresql://<user>:<encoded-password>@<managed-host>:<port>/<database>?<provider-options>`; `postgres:` also accepted. Respect provider TLS and encode special password characters. No loopback in production. Reviewed additive deploy command: `npm run db:deploy` after backup/status/review. Never migrate reset/db push against production. |
| **C Redis** | `REDIS_URL=redis://...` or `rediss://...` for TLS; reachable managed/internal hostname, URL-encoded credentials if required; `REDIS_PREFIX=clipforge` (stable namespace, isolated per environment). No production loopback. |
| **D storage** | `STORAGE_DRIVER=s3` + `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; optional custom `S3_ENDPOINT` and boolean `S3_FORCE_PATH_STYLE`. OR local trio above with actual paid disk. `UPLOAD_PART_SIZE_MIB` 1–64 local / 5–64 S3. Public base aliases optional for S3, not a substitute for private ID routes. |
| **E authentication** | `TELEGRAM_BOT_TOKEN` from BotFather, `TELEGRAM_BOT_USERNAME` (without @), `TELEGRAM_WEBHOOK_SECRET` 16–256 URL-safe chars are required in production. `TELEGRAM_WEBHOOK_URL=https://youtubeautomatin.onrender.com/api/auth/telegram/webhook` for webhook registration; public HTTPS hostname/exact path required, never localhost/IP. Optional `TELEGRAM_BOT_ID` must match token prefix; `TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS` 60–600 default 300. `TELEGRAM_API_BASE` defaults to official API; `TELEGRAM_TIMEOUT_MS` / `TELEGRAM_MAX_ATTEMPTS` bound transport. `TELEGRAM_CHAT_ID` is optional notification destination, not browser identity. Users must press Start in the bot. Existing password/Firebase/OIDC fields do NOT enable active alternate login. |
| **F AI** | API requires URL `AI_ENGINE_URL` and >=8-character secret `AI_ENGINE_API_KEY` (same secret on service). AI service additionally requires `AI_PROVIDER=gemini`, `WHISPER_MODEL`, `WORK_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`; real provider use requires `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL`. `WHISPER_DEVICE`/`WHISPER_COMPUTE_TYPE` fit available hardware. `TEST_MODE=0` production; fixture provider forbidden. Models/credentials are not needed for basic auth/dashboard readiness but are needed for processing. |
| **G processor** | API requires URL `VIDEO_PROCESSOR_URL` + >=8-character `VIDEO_PROCESSOR_API_KEY`, same key on FastAPI processor. Processor uses `WORK_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`. Identical absolute WORK_DIR shared mount required for current path RPCs. |
| **H YouTube (optional until connect/publish)** | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI=https://youtubeautomation-mauve.vercel.app/api/accounts/youtube/callback`; register that exact callback and required scopes with provider. No test publish without explicit authorization. |
| **I Instagram (optional until connect/publish)** | `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_API_VERSION` explicitly supported by connector, `META_REDIRECT_URI=https://youtubeautomation-mauve.vercel.app/api/accounts/instagram/callback`; register exact callback. Eligible account/scopes/provider approval and reachable HTTPS S3 signed media delivery still require live verification. No invented webhook-verify setting. |
| **J frontend** | Vercel Root Directory `apps/web`; `API_INTERNAL_URL=https://youtubeautomatin.onrender.com` set for appropriate production environment, then redeploy. Fallback committed api-target.json uses same backend. `UPLOAD_CSP_ORIGINS` optional comma-separated exact custom S3 endpoint origins if needed. No server credentials in frontend variables. |

Optional/default operational controls: `PORT` is injected by Render and wins over `API_PORT` (default 4000); `TRUST_PROXY` default 1, set for actual trusted proxy topology; `LOG_LEVEL=info`; `API_DOCS_ENABLED=false`; `HEALTHCHECK_TIMEOUT_MS=5000`; `WORKER_SHUTDOWN_GRACE_MS=30000`; `WORKER_CONCURRENCY_AI`, `WORKER_CONCURRENCY_RENDER`, `WORKER_CONCURRENCY_PUBLISH`; `JOB_LEASE_SECONDS` / `JOB_HEARTBEAT_SECONDS` (lease comfortably exceeds heartbeat interval). Legacy SMTP/Firebase/OIDC/bootstrap fields are retained for historical code/config compatibility, not active login alternatives. PRICE_* settings affect accounting estimates only. See CONFIGURATION.md for workspace/database configuration keys, which are separate from process environment fields.

## Exact deployment actions still needed

### Existing Render API

Do not provision a duplicate service. Repository root build: `npm ci --include=dev && npm run build:api`. Start: `npm run start:api` -> compiled `node dist/main.js`. Keep compatible Node 22.22.3 (or documented supported Node). Health path `/api/system/health`. Set A–G configuration names above; select durable S3 or provision the paid local disk. Use actual managed DB/Redis URLs and provider TLS. Apply reviewed additive migrations as a separate controlled release step, then restart/redeploy and inspect sanitized startup dependency guidance. `render.api.yaml` is native-Node reference; `render.yaml` is the separate Docker blueprint. Neither changes the existing service's dashboard settings automatically. The evaluation blueprint's free DB/Redis plans are not production durability guarantees.

### Existing Vercel frontend

Root `apps/web`; use committed root lockfile/workspace build. Configure J, then **redeploy**: rewrites are build-time inputs. A stale Vercel `API_INTERNAL_URL` overrides committed fallback and must be corrected in Vercel settings. Confirm `/healthz` reports `apiTarget=https://youtubeautomatin.onrender.com`, then verify `/api/auth/providers`, `/api/auth/csrf`, `/api/auth/session` through the frontend origin and complete a real bot login. Session/CSRF cookies are HttpOnly/Secure/SameSite=Lax; proxy should preserve Cookie/Set-Cookie and Origin without injecting browser identity or exposing secrets. No CORS wildcard or weakened session flags were added. OAuth callbacks registered on the frontend origin traverse the same proxy.

## Actual public deployment observations

Freshly fetched this pass (not inference from old logs):

- `https://youtubeautomation-mauve.vercel.app/healthz` returned JSON with `ok:false`, target `https://api-not-configured.invalid`, failure code `API_TARGET_NOT_CONFIGURED`, deployed commit `206618a`. Repository fallback is now corrected, but that observed deployment has not been redeployed by this agent.
- `https://youtubeautomatin.onrender.com/api/system/health` returned a Render **Application loading** HTML page, not ClipForge JSON. This does not prove the backend started or that DB/Redis/storage are healthy. No specific current Render boot exception is asserted without runtime logs.

## Verification results

- `npm install`: passed initially; after targeted changes, clean install, `npm ci`, and a subsequent normal `npm install` all passed. During a rejected Vitest patch experiment npm hit an override-reference/peer-layout error; restored the original Vitest pin, reconciled only intended dependency changes from the original lockfile and verified clean repeatable installs. No force/audit-fix was used; TypeScript remains 5.9.3 and Vitest remains 2.1.8.
- Ordinary `npm run build`: **blocked/failed** at Prisma native engine download from `binaries.prisma.sh` (TLS/network restriction). Do not present this as an application TypeScript error or prescribe fake engine binaries to production.
- Sandbox compile-only `PRISMA_GENERATE_NO_ENGINE=1 PRISMA_QUERY_ENGINE_LIBRARY=/bin/true PRISMA_QUERY_ENGINE_BINARY=/bin/true PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npm run build`: passed packages, API and Next production compilation. API dist/main.js generated. **Not native Prisma runtime proof.**
- `npm run typecheck` with the same sandbox engine-generation variables: passed all workspace TypeScript checks.
- Full unit suite (`SESSION_SECRET` isolated test value, `npx vitest run --config tests/vitest.config.ts`): **422 passed, 3 skipped, 59 files passed** before the final notification-lifecycle/log regression test (latest rerun recorded below).
- `npm run lint`: passed configured web ESLint.
- `PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -m unittest discover -s tests/python`: **29 passed, none skipped**, including real FFmpeg vertical render/subtitle/output validation using isolated synthetic fixtures. No real AI quality claim.
- Prisma `validate --schema packages/database/prisma/schema.prisma`: passed using schema validation with isolated dummy URL and sandbox engine-path variables. No DB connection/migration executed; native engine availability is not certified.
- Production command negative test: actual `npm run start:api` against isolated invalid test dependencies exited **1**, did **not** log/listen as a healthy API, and emitted sanitized dependency guidance. Engine-free client cannot establish a native connection; no successful production boot is claimed.
- `npx vitest run --config tests/vitest.integration.config.ts`: **4 suites failed, 19 tests skipped**, missing root `.env`/configured external services. These are blocked integration checks, not successful tests. Did not create a root .env or run destructive SQL. Some older browser/E2E harnesses reference retired password fixtures; they are not current Telegram login evidence.
- Migration source scan: ten migrations; no DROP TABLE, DROP COLUMN, TRUNCATE or DELETE FROM markers found. Static scan is NOT existing-data integrity proof. No schema/migration files changed.
- Remaining `npm audit` findings after targeted fixes: runtime critical count **0** (initially 1); runtime high/moderate advisories remain. Full dev-inclusive audit still reports critical Vitest/Tinypool advisories; do not expose the test UI server. An ineffective patch upgrade was not retained. A separately tested tooling/framework/legacy-dependency security upgrade is a release gate, not hidden by this report.

## Files / change accountability

- Created this pass: `common/database.module.ts`, `common/startup-error.ts`, `web/lib/api-origin.ts`, startup/env/proxy/multipart regression test files, and this report.
- Modified: application/feature module Prisma registrations; Prisma/Redis/storage startup lifecycle; system health; notifications startup lifecycle; safe exception filter/fatal/request logging; env validation/example; API/root manifests and lockfile for targeted S3/Multer security fixes; Next config/committed target; Render YAML references; existing test contracts; documentation index. `git diff --name-status` and PR Files changed provide the exact cumulative list, including the preserved previous increment.
- Removed application files: **none**. Removed only duplicate/unconsumed example variables and obsolete inactive-auth deployment entries after reference inspection; legacy source/migrations/users/history preserved. Generated node_modules were rebuilt during install verification, not committed.
- Earlier branch commit `2bd9fe5`: private media/job lease/Python boundaries/signed delivery/calendar work from preceding requests, preserved separately. Foundation changes are the following logical commits; PR description lists actual SHAs.

## Remaining release gates

1. Native Prisma generate/build and migrations/status against an authorized disposable or backed-up managed DB; existing-user/workspace/session integrity proof.
2. Real Redis TLS/noeviction/persistence, queue/worker/reconnection/graceful-shutdown integration; recovery/state-transition race fencing remains unproven.
3. Real S3 bucket/CORS/permissions/readback or verified paid disk mount/capacity/backups. Timeout cleanup is best-effort; lifecycle policy for stale probe/work artifacts recommended.
4. Vercel redeploy and Render startup with actual settings, then successful core health, auth proxy cookies, bot webhook secret/state/one-use session flow and real ownership tests.
5. Resolve remaining relevant dependency advisories with compatible tested upgrades; absence of runtime critical advisories alone is not a production security certification.
6. Shared WORK_DIR topology verification before any split Render processing deployment. Actual Whisper/Gemini/provider workflows, permissions/app approvals and publishing are outside this foundation pass and not claimed tested.

**Do not merge/deploy as fully production-certified while these gates remain open.** The PR is a reviewable foundation hardening change with transparent blocked checks, not an automatic release approval.


### Latest final rerun

After clean dependency reconciliation and the notification/log changes:

- Hosted build: `VERCEL=1` plus the documented sandbox-only Prisma generation variables, `npm run build`: **passed**. Inspected `.next/routes-manifest.json`: both `/api/:path*` and `/media/:path*` compile to `https://youtubeautomatin.onrender.com` with matching prefixes. `apps/api/dist/main.js` exists. This is compiled configuration proof, not a Vercel redeploy or successful backend boot.
- Full unit suite: **424 passed, 3 skipped, 60 test files passed**.
- Python: **29 passed, zero skipped** with test-only FFmpeg/ffprobe available.
- Lint passed; structure **82 passed, zero failed**; diff whitespace checks passed.
- Final production dependency audit: **23 findings — 14 moderate, 9 high, zero critical**. Dev-inclusive audit: **38 findings — 2 low, 24 moderate, 10 high, 2 critical**. Remaining issues prevent an unqualified security/release approval.

### Remaining production advisory packages

The following npm audit package classifications include inherited/transitive findings; package classification is not proof that every advisory is remotely exploitable through the current API. They still require a compatibility/reachability review and tested remediation, not dismissal:

| Package | Severity | Direct dependency |
|---|---|---|
| `@google-cloud/firestore` | moderate | no |
| `@google-cloud/storage` | moderate | no |
| `@nestjs/common` | moderate | yes |
| `@nestjs/core` | moderate | yes |
| `@nestjs/platform-express` | moderate | yes |
| `@nestjs/swagger` | high | yes |
| `body-parser` | high | no |
| `bullmq` | moderate | yes |
| `express` | high | no |
| `firebase-admin` | moderate | yes |
| `gaxios` | moderate | no |
| `google-gax` | moderate | no |
| `js-yaml` | high | no |
| `lodash` | high | no |
| `next` | moderate | yes |
| `nodemailer` | high | yes |
| `path-to-regexp` | high | no |
| `postcss` | high | no |
| `qs` | moderate | no |
| `retry-request` | moderate | no |
| `teeny-request` | moderate | no |
| `uuid` | moderate | no |
| `zod` | high | yes |


## Exact cumulative branch file manifest

Compared with the user-provided base commit; A=create, M=modify. No application file is deleted.

```text
M	.env.example
M	apps/api/package.json
M	apps/api/scripts/run-workers.sh
M	apps/api/src/accounts/accounts.controller.ts
M	apps/api/src/app.module.ts
M	apps/api/src/clips/clips.module.ts
M	apps/api/src/clips/clips.service.ts
A	apps/api/src/common/database.module.ts
M	apps/api/src/common/env.ts
M	apps/api/src/common/filters/all-exceptions.filter.ts
M	apps/api/src/common/interceptors/request-id.interceptor.ts
M	apps/api/src/common/prisma.service.ts
M	apps/api/src/common/services/redis.service.ts
A	apps/api/src/common/startup-error.ts
M	apps/api/src/jobs/jobs.module.ts
M	apps/api/src/main.ts
M	apps/api/src/media/media.controller.ts
M	apps/api/src/notifications/notifications.service.ts
A	apps/api/src/publishing/publishing-query.ts
M	apps/api/src/publishing/publishing.controller.ts
M	apps/api/src/publishing/publishing.module.ts
M	apps/api/src/publishing/publishing.service.ts
M	apps/api/src/sources/sources.module.ts
M	apps/api/src/sources/sources.service.ts
M	apps/api/src/storage/storage.service.ts
M	apps/api/src/system/system.controller.ts
M	apps/api/src/system/system.module.ts
M	apps/api/src/system/system.service.ts
M	apps/api/src/usage/usage.module.ts
M	apps/api/src/workers/base.ts
A	apps/api/src/workers/lease-contention.ts
M	apps/api/src/workers/pipeline.worker.ts
M	apps/api/src/workers/publish.worker.ts
M	apps/api/src/workers/render.worker.ts
M	apps/api/src/workspace/workspace.module.ts
M	apps/web/api-target.json
A	apps/web/app/calendar/page.tsx
M	apps/web/app/page.tsx
M	apps/web/app/publishing/page.tsx
M	apps/web/components/shell.tsx
A	apps/web/lib/api-origin.ts
A	apps/web/lib/calendar.ts
M	apps/web/lib/hooks.ts
M	apps/web/next.config.ts
M	docker-compose.dev.yml
M	docker-compose.prod.yml
M	docs/ARCHITECTURE.md
M	docs/CONFIGURATION.md
M	docs/DEPLOY-VERCEL.md
M	docs/DOCUMENT-INDEX.md
M	docs/README.md
A	docs/foundation-audit.md
A	docs/platform-engineering-ledger.md
M	docs/render-api-production.md
M	infrastructure/docker/ai-engine.Dockerfile
M	infrastructure/docker/video-processor.Dockerfile
M	infrastructure/docker/web.Dockerfile
M	package-lock.json
M	package.json
M	packages/database/src/repositories.ts
M	render.pipeline.yaml
M	render.yaml
M	services/ai-engine/app/config.py
M	services/ai-engine/app/main.py
A	services/media_paths.py
M	services/video-processor/app/main.py
A	tests/python/test_ai_fixture_guard.py
A	tests/python/test_media_paths.py
A	tests/python/test_render_http.py
A	tests/unit/api-origin.test.ts
A	tests/unit/foundation-env.test.ts
A	tests/unit/lease-contention.test.ts
A	tests/unit/multipart-compatibility.test.ts
A	tests/unit/oauth-redirect-security.test.ts
A	tests/unit/private-media.test.ts
A	tests/unit/production-connections.test.ts
M	tests/unit/production-dependencies.test.ts
A	tests/unit/publishing-calendar.test.ts
A	tests/unit/repository-leases.test.ts
A	tests/unit/signed-media.test.ts
M	tests/unit/source-library.test.ts
A	tests/unit/startup-dependencies.test.ts
A	tests/unit/startup-log-security.test.ts
M	tests/unit/system-readiness.test.ts
A	tests/unit/worker-launcher.test.ts
```

Foundation implementation commits: `5da911c` (startup/proxy/health/security tests), `70e7fdc` (targeted dependency patches); `2bd9fe5` preserves the preceding task's implementation. The following documentation/deployment commit and final PR URL are recorded in the PR description.
