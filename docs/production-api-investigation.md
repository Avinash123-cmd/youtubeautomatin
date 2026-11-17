# Production API/proxy investigation — 2026-11-16

## Confirmed public evidence

Read-only requests were made to the user-supplied public frontend and backend. No login, webhook,
secret, session creation or database operation was attempted.

The deployed frontend `/healthz` returned:

```json
{
  "ok": false,
  "apiTarget": "https://api-not-configured.invalid",
  "origin": "https://api-not-configured.invalid",
  "upstream": { "status": null, "error": "fetch failed" },
  "identity": "unknown",
  "region": "bom1",
  "commit": "0fa0f13"
}
```

Its hint explicitly says no API origin was configured for this build. The public frontend
`/api/auth/session` returned Vercel's **502 DNS_HOSTNAME_NOT_FOUND**, not a Nest error envelope.
The fetch tool returned response bodies/titles, not raw HTTP headers; the browser supplied the
healthz 503 observation. The sentinel hostname cannot resolve by design.

**Exact immediate root cause:** this frontend build has no usable API target and therefore rewrites
session requests to the sentinel, not the supplied Render backend. The assets work because they
are served by Vercel independently. This failure happens before Nest, CORS, authentication, cookies,
PostgreSQL or Redis can answer. Changing those systems cannot fix sentinel DNS resolution.

Direct backend `/api/system/live`, `/api/system/health` and `/api/auth/session` requests returned
Render's **Application loading** HTML, not ClipForge JSON. A repeated liveness request also returned
the loading page. This does not establish a healthy backend or an exact crash reason: cold start,
failed boot or unavailable instance still require Render logs. No precise upstream HTTP status or
DB/Redis fault is inferred from that HTML.

## Repository/deployment comparison

GitHub main was checked using `gh api repos/Avinash123-cmd/youtubeautomatin/commits/main` and remained
`0fa0f13572e51cce279312ae868872bc9ce4139d` (PR10 merge). That agrees with the frontend commit marker.
Main pins TypeScript 5.7.2; the previously requested 5.9.3 edits remain local/uncommitted on this
branch. Local compiler/build success does not prove Render has deployed those changes. TS5108 did
not reproduce locally, but the reported Render compiler failure cannot be declared fixed in
production without a successful build log from the deployed revision.

## Configuration and request flow audit

- Next next.config.ts resolves API_INTERNAL_URL first, then api-target.json for hosted builds,
  otherwise the local default. The committed file has apiOrigin=null. Hosted builds with neither
  usable value use the sentinel. No real hostname was hardcoded as a fallback in this repair.
- The target is compiled into rewrites and CLIPFORGE_API_TARGET. Runtime-only environment changes
  cannot repair an existing bundle: rebuild/redeploy Vercel after setting the build-time value.
- `/api/:path*` rewrites to the configured API origin preserving `/api/:path*`. There is no separate
  frontend session route implementation to replace. `useSession` calls `/api/auth/session` and the
  existing public BotAuthController route describes the existing session without creating one.
- `/healthz` is dynamic/no-store and probes `/api/system/health` on that exact compiled target,
  with a five-second timeout and response-shape check. It correctly reports failure rather than
  pretending the dashboard/API connection works.
- PrismaService awaits a real database connection during initialization; errors propagate and boot
  cannot successfully listen if this step fails. Redis uses real ioredis clients with bounded
  requests and error diagnostics. DB/Redis affect core readiness; no health success was fabricated.
- Environment validation requires actual DB, Redis, secrets, storage, service URLs and production
  Telegram configuration. Production APP_URL must be HTTPS. ALLOWED_ORIGINS is an explicit origin
  allowlist used by CORS/CSRF checks. Provider-side values cannot be inspected from public pages.

## Required environment correction (not yet applied to hosting)

**Confirmed correction:** in the Vercel project serving the provided frontend, set
`API_INTERNAL_URL` for the **Production build environment** to the supplied backend's HTTPS origin,
without `/api` or a trailing slash, then rebuild/redeploy. Use the actual intended origin from the
service dashboard. Setting it on Render, only on Preview, or only at runtime will not repair this
Vercel production build. Do not set CLIPFORGE_API_TARGET manually; Next compiles it from the target.

**Verify, not proven wrong:** on Render, APP_URL should be the supplied frontend's HTTPS origin and
ALLOWED_ORIGINS must explicitly include that origin. Preserve all security checks; do not use a
wildcard to bypass a proxy/DNS failure. These settings do not explain the confirmed sentinel error.

Also verify real DATABASE_URL, REDIS_URL, REDIS_PREFIX, SESSION_SECRET (at least 32 chars),
CREDENTIAL_ENCRYPTION_KEY (32 bytes base64), TIMEZONE, STORAGE_DRIVER with its driver-specific keys,
WORK_DIR, AI_ENGINE_URL/AI_ENGINE_API_KEY, VIDEO_PROCESSOR_URL/VIDEO_PROCESSOR_API_KEY and the
production Telegram trio TELEGRAM_BOT_TOKEN/TELEGRAM_BOT_USERNAME/TELEGRAM_WEBHOOK_SECRET. Leave
Render's PORT injection intact. No evidence here proves these are missing on Render; consult its
startup logs and never paste their values into chat. See [production startup](render-api-production.md).

No Vercel or Render administrative connection is available in this session, so no provider
configuration or deployment was changed. Public-origin values belong in the hosting configuration,
not hardcoded source defaults.

## Minimal code changes for this investigation

- apps/web/lib/upstream-diagnostics.ts: allowlisted DNS/refused/timeout failure classification and
  safe structured server logging. Only sanitized origin, fixed health endpoint, HTTP status,
  latency and a diagnostic code are emitted. No raw error messages, URL credentials/query/path,
  request headers, cookies, tokens, bodies or session identifiers are logged.
- apps/web/app/healthz/route.ts: logs failed probes with the helper and adds upstream.failureCode,
  distinguishing API_TARGET_NOT_CONFIGURED from transport failures. Existing status/identity/proxy
  behavior remains unchanged; no auth/session proxy was replaced. Public errors no longer echo raw
  driver/fetch error messages.
- tests/unit/upstream-diagnostics.test.ts: seven tests for classification, credential redaction,
  missing-target diagnosis and healthy responses without failure logging.
- This report and docs/DOCUMENT-INDEX.md document the confirmed cause and release gates.

The existing uncommitted TS5.9.3 pin changes from the preceding task are preserved separately:
root and six workspace package.json files, package-lock.json, compiler test and compiler report.
No unrelated application, session, database or origin-policy changes were introduced.

## Build/test evidence

- npx tsc --version: **5.9.3**; compiled apps/api/dist/main.js exists.
- Full root workspace/API/Next production build: exit 0 with sandbox-only engine-free Prisma
  generation (same flags and limitations as the [compiler report](typescript-build-toolchain.md)).
  No TS5108. Normal native generation remains blocked by sandbox access to binaries.prisma.sh;
  do not copy these flags to Render.
- Frontend TypeScript check and workspace ESLint: passed.
- Full isolated unit suite: **351 passed, 3 opt-in proxy cases skipped, 46 files**, using a test-only
  SESSION_SECRET. New diagnostics tests: 7 passed. Initial tests found an incorrect relative import
  in the new route change; corrected before the final successful build/test run.
- Public production checks still show the missing-target deployment/loading backend described
  above. There is no successful live deployment or real authenticated-session verification claim.

## Deployment verification order

1. Merge/deploy the intended revision. Confirm Render logs the expected TypeScript version and
   successful compilation, then executes compiled-JS startup, not dev/watch mode. Repository-root
   build: `npm ci --include=dev && npm run build:api`; start: `npm run start:api` (delegates start:prod).
2. Check direct Render `/api/system/live` for ClipForge JSON, not loading HTML. Then check
   `/api/system/health` and `/api/system/readiness`. Inspect logs for DB/Redis/configuration errors
   if unhealthy; do not reset the database or weaken readiness.
3. Verify direct cookie-free `/api/auth/session`: HTTP200 authenticated=false, without faking login.
4. Correct Vercel Production API_INTERNAL_URL and **rebuild** the frontend. Confirm `/healthz`
   reports the intended origin (not sentinel), current commit, ClipForge identity and healthy status.
5. Verify frontend `/api/system/live` and `/api/auth/session`. DNS_HOSTNAME_NOT_FOUND should no
   longer occur. Only then test real bot authentication with configured services and secure cookies.

Until these steps pass on the actual hosts, this is a diagnosed configuration failure with tested
diagnostics, not a completed production recovery.
