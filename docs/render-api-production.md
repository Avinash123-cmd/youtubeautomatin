# ClipForge API: compiled-only production startup on Render

Date: 2026-11-16. Service: `youtubeautomatin`. Target deployment branch: `main` after this repair is merged.

## Root cause

The supplied log reports a successful production build, then runs **`npm run dev`**. In the API
workspace that invokes `scripts/dev-api.cjs`, a TypeScript watch supervisor. It compiles again,
retains a compiler process and starts the HTTP child only after successful compilation. The log
shows that compiler exhausting its heap before the child binds; Render's port scanner therefore
finds no listener. This is a production Start Command error, not evidence that the app needs a
larger heap. No NODE_OPTIONS memory expansion was added.

`apps/api/tsconfig.json` sets rootDir=src and outDir=dist, extending CommonJS compiler settings.
The actual build emits **`apps/api/dist/main.js`** and its imported modules/declarations. It does
not bundle workspace dependencies. Runtime resolution uses root npm workspace links to each
package's own `dist/index.js`; keep packages, manifests, root node_modules and the generated
node_modules/.prisma client with the build. Do not deploy only dist/main.js in isolation.

The existing API `start` command already ran compiled JavaScript. The repair adds explicit
`start:prod` and routes root `start:api` to it, making the correct dashboard setting unambiguous.
There is no prestart compilation and no watch supervisor in the production start path.

The supplied build succeeded with Root Directory=apps/api, demonstrating that this particular
build could reach sibling packages. That setting is **not the cause of the reported post-build
OOM**. App-local builds remain supported when the full checkout is available. Repository-root
settings below make the dependency/lockfile/schema context explicit and are the canonical native
Node deployment configuration.

## Exact settings for the existing Render Node Web Service

Update the existing service's dashboard settings; committing a blueprint does not update a manually
configured service. Do not accidentally provision a second API or replace/delete your database.

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Branch | main (after merge) |
| Root Directory | **Blank**, meaning repository root |
| Build Command | `npm ci --include=dev && npm run build:api` |
| Start Command | `npm run start:api` |
| Health Check Path | `/api/system/health` |
| NODE_ENV | production |
| NODE_VERSION | 22.22.3 |

`render.api.yaml` is an optional equivalent native Node blueprint, selected explicitly through its
Blueprint path. The existing `render.yaml` and `render.pipeline.yaml` remain Docker deployments;
their compiled-JavaScript entrypoint is already distinct from the bad manual Start Command.
The native blueprint does not create PostgreSQL/Redis or select a storage provider on your behalf.
Fill those settings before deploying it. Do not import it merely to update a manual service.

After correcting settings, clear the build cache and deploy once. Expected sequence:

1. Lockfile installation includes build tools (dev dependencies).
2. shared-types → validation → platform-connectors → database (including normal Prisma generation)
   → API TypeScript compilation.
3. `start:api` → API `start:prod` → `node dist/main.js` in apps/api.
4. Environment validation and Nest lifecycle initialization run.
5. A successful HTTP bind logs **ClipForge API listening**, with host and effective port. Nest's
   earlier "application successfully started" line is initialization, not proof of a bound socket.

Never put `npm run dev`, ts-node, tsx, nodemon or tsc watch in Start Command. The development
supervisor now refuses NODE_ENV=production or RENDER=true, including a predev check before workspace
compilation. Local development otherwise remains unchanged. Runtime errors are not hidden: invalid
environment, database initialization or bind errors terminate nonzero. No ports are auto-selected
or foreign processes killed.

## Ports, dependencies and health

The host-injected **PORT takes precedence**, validated as an integer 1–65535. If PORT is absent,
API_PORT remains the backward-compatible local/Docker fallback, defaulting to 4000. Invalid values
fail validation rather than silently selecting a different port. The API binds `0.0.0.0`, and logs
the effective port only after the listen promise succeeds. Do not manually force Render PORT to
4000. Leave its injected value alone; API_PORT may remain for local compatibility.

Prisma generation runs in the database workspace against packages/database/prisma/schema.prisma
at build time. It does not apply migrations or require an active database to generate the client.
The actual startup still calls Prisma $connect; connection failures now have an explicit PostgreSQL
configuration/network diagnostic and retain the original cause. Nothing bypasses database access.
Redis clients remain real ioredis connections with bounded request behavior. Connection errors now
produce a credential-safe diagnostic instead of unhandled/raw driver error output; no successful
Redis state is fabricated. Existing health probes continue to mark failed Redis/DB dependencies
unhealthy, and the configured Render readiness health check must pass before traffic is routed.

Health endpoint behavior was not changed:

- `/api/system/live`: process-only liveness (`status: ok, service: clipforge-api`) after HTTP startup;
  not proof that dependencies are ready.
- `/api/system/health`: core PostgreSQL/Redis readiness; non-ready dependencies return 503.
- `/api/system/readiness`: detailed sanitized readiness, processing/publishing readiness and worker
  status; intentionally can report unavailable optional pipeline services.

Do not change Render's health check to liveness just to hide missing required services.

## Required runtime configuration

Set actual values privately in Render. No credentials were available for this service in the
sandbox and its dashboard environment was not inspected. Refer to .env.example for the complete
inventory; never paste secrets into chat or commit a root .env.

- `NODE_ENV=production`, `APP_URL` (real frontend HTTPS origin), `ALLOWED_ORIGINS` (explicit allowed
  frontend origins), `TIMEZONE=Asia/Kolkata`; `LOG_LEVEL=info` is sufficient.
- `DATABASE_URL`: actual PostgreSQL credentials/host/database, with TLS settings appropriate to the
  provider. `REDIS_URL`: actual reachable Redis/Key Value URL (`rediss://` when TLS is required).
  `REDIS_PREFIX=clipforge` or your existing prefix.
- `SESSION_SECRET`: at least 32 characters. `CREDENTIAL_ENCRYPTION_KEY`: base64 encoding of exactly
  32 random bytes. **Preserve existing values** or sessions/encrypted integration credentials break.
- `STORAGE_DRIVER` and `WORK_DIR` (for example /tmp/clipforge/work). For local storage additionally
  `STORAGE_LOCAL_ROOT` and `STORAGE_LOCAL_PUBLIC_BASE_URL` (your actual API origin). Render local disk
  is ephemeral; durable production media needs configured S3-compatible storage. S3 requires
  `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; set endpoint/public URL and other
  options for your provider. Do not use invented storage values to suppress validation.
- `AI_ENGINE_URL`, `AI_ENGINE_API_KEY` (at least 8 chars), `VIDEO_PROCESSOR_URL`,
  `VIDEO_PROCESSOR_API_KEY` (at least 8 chars). Actual processing additionally needs those services
  and separate workers. Deploying only this API does not deploy the pipeline.
- Production Telegram-only authentication requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`
  (without @), and `TELEGRAM_WEBHOOK_SECRET` (16–256 URL-safe characters). Configure
  `TELEGRAM_WEBHOOK_URL` to the real public HTTPS service hostname ending
  `/api/auth/telegram/webhook` before registering the webhook; optional TELEGRAM_BOT_ID must match
  the token's bot ID. APP_URL must use HTTPS. Follow [existing bot setup](existing-telegram-bot-setup.md).
  No alternative login provider was activated.
- `PORT` is supplied by Render; `NODE_VERSION=22.22.3` selects the tested native runtime. Existing
  TRUST_PROXY and session/CSRF/security settings remain in force.

A sandbox environment probe found these required schema fields absent: NODE_ENV, APP_URL,
ALLOWED_ORIGINS, TIMEZONE, DATABASE_URL, REDIS_URL, REDIS_PREFIX, CREDENTIAL_ENCRYPTION_KEY,
SESSION_SECRET, STORAGE_DRIVER, WORK_DIR, AI_ENGINE_URL, AI_ENGINE_API_KEY, VIDEO_PROCESSOR_URL,
VIDEO_PROCESSOR_API_KEY. Production also requires the Telegram trio and driver-specific storage
settings. This describes the sandbox, **not an assertion that those values are absent on Render**.

## Safe migrations

Before routing production traffic, apply reviewed pending additive migrations to the correct
existing database. Back it up first. Where Render supports a pre-deploy command, use:

```
npm run db:deploy
```

This resolves to the database workspace's `prisma migrate deploy`, using its own schema path.
If the plan does not support pre-deploy commands, run this exact command from a trusted operator
checkout/release job with the same production DATABASE_URL and Prisma CLI available. Coordinate it
before releasing the new API. Do not put migrations in the build stage, do not run migrate dev,
db push, seed or reset against production, and do not recreate the database to fix a failed migration.
The native Start Command neither resets data nor runs migrations automatically. Docker's separate
RUN_MIGRATIONS entrypoint behavior is unchanged.

## Node compatibility

The broad repository engines range allowed Node 24, but that is not certification of the entire
older dependency stack on Node 24. The supplied OOM log identifies a development compiler workload,
not a proven Node 24 incompatibility. `.node-version` and the native blueprint explicitly pin
**Node 22.22.3**, the LTS version used for local verification, avoiding Render's changing default.
No Prisma version was changed, no packages were added and no heap-size workaround was introduced.
Remove or update a dashboard NODE_VERSION override pointing at 24, since it can override the file.
Existing Docker images retain their separately pinned Node runtime; this repair targets the native
service described in the incident.

## Verification and remaining release gates

- Workspace build and actual dist/main.js entry checked; real unaliased Node resolution tests load
  database, platform-connectors, validation, shared-types and generated Prisma model metadata.
- Port tests verify PORT precedence, API_PORT/default fallback, invalid-port rejection, awaited bind
  failure and a real isolated Nest socket bound to 0.0.0.0 using the same listener as production.
- Production start tests verify compiled-JS command wiring, absence of prestart compilation, refusal
  of the dev watcher and nonzero exit from compiled production startup when configuration is missing.
- PostgreSQL failure/cleanup and sanitized Redis error/cleanup tests use isolated test doubles only;
  production services are unchanged real clients. Existing health/readiness tests remain in use.
- Normal native Prisma generation was attempted but its binary download was blocked by this
  sandbox's restricted access to binaries.prisma.sh. Engine-free generation was used for compilation
  and tests **only**. Never set the sandbox's engine overrides or PRISMA_GENERATE_NO_ENGINE on Render.
- Final unit suite: **340 passed, 3 opt-in proxy cases skipped across 44 files**. API/frontend
  TypeScript checks, ESLint and **82 structure checks** passed; native blueprint YAML parsed. The API
  workspace build passed using sandbox-only engine-free generation, with all five compiled entries
  present. Direct production start and guarded dev attempts both exited 1 as expected when required
  configuration was absent / production dev was prohibited. No full authenticated production
  AppModule boot, live PostgreSQL/Redis connection, migration, real bot login or Render deployment
  was verified. The isolated listener test is **not** a successful production deployment.

After deployment, request all three health routes on your actual hostname and verify the database,
Redis and relevant workers. Update/rebuild the frontend only if its existing API target needs to
change; no frontend or production URL was modified in this repair.
