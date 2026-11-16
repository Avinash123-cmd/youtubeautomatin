# Authentication endpoint diagnostics and repairs — 2026-11-16

## Scope and diagnosis (do not confuse verified defects with hypotheses)

This work is on top of the merged CSRF dependency-injection repair. The current AuthController has explicit injection tokens and the API development launcher uses tsc, not tsx. **Neither reported HTTP 500 is reproduced on the current controller with valid base configuration and no optional OAuth credentials.** Windows runtime logs, launch command, .env, database, Redis and real account are not available in this checkout. It would be incorrect to label missing optional OAuth settings as the proven root cause of either Windows 500.

Independent traces:

- GET /api/auth/providers: global CORS/session/rate/CSRF guards → AuthController.providers → FirebaseService.configured/init/serviceAccount, webConfig, missing → TelegramOidcService.configured → TelegramAccountService.botUsername → plain serializable response. For a fresh anonymous safe GET, no Redis command, database query, Telegram request or Google token verification is needed. Fully absent OAuth credentials return password=true, Firebase disabled with config=null, Telegram disabled with botUsername=null. These are real service results, not fake successful provider responses. Configured means settings/SDK initialization are present, not proof the external provider is reachable or a popup login has succeeded.
- GET /api/auth/csrf: same guard boundary → injected SessionService.issueAnonymousCsrf → 24 cryptographically random bytes → HMAC-SHA256 with validated SESSION_SECRET → Express HttpOnly cookie and csrfToken JSON. This currently returns 200 directly and through Next. Invalid origins remain 403. Cookie and header must agree on unsafe requests; session CSRF remains session-bound. No production security change.
- Both routes: if a cf_session cookie is supplied, SessionAuthGuard validates it against PostgreSQL before the handler, even on public routes. Thus database/session failure is a shared possible dependency, but is **not established as the cause** here. A successful request to the dependency-free /pending handler does not establish that all authentication dependencies work for every cookie state.
- Previous, independently reproduced CSRF root cause: tsx omitted Nest design:paramtypes and SessionService was undefined. That fix is already present. Stale compiled output or an old running process is possible on Windows, but not verified.

Confirmed new defects repaired:

1. Session GET could return 304 due to Express freshness handling. Reproduced even with If-None-Match: *. Authentication middleware now rejects conditional-cache semantics; auth replies are no-store/no-cache and API ETags are disabled. This is not claimed to explain the HTTP 500s.
2. Frontend discarded backend request IDs, mislabeled CSRF token rejection as an origin failure, and did not display provider-query failures/retry UI. Repaired.
3. Request IDs were assigned only in an interceptor, after guards. CORS/session/CSRF failures could lack useful correlation IDs. Middleware now assigns bounded IDs before CORS/guards; interceptor reuses them.
4. Global filter passed a stack as Pino's second string argument, which does not reliably emit that stack. It now records error type and structured call-site frames with request ID/path/method, without raw exception messages (which can contain provider credentials). Public 500 remains sanitized.
5. Firebase service-account JSON used an unchecked cast and public discovery could expose SDK exception text. JSON shape is now validated; unusable credentials disable Firebase with a fixed configuration diagnosis. Missing credentials remain nonfatal. No claim that malformed JSON caused the reported Windows 500.

## Modified files

- apps/api/src/auth/firebase.service.ts
- apps/api/src/common/auth-http.middleware.ts (new)
- apps/api/src/common/filters/all-exceptions.filter.ts
- apps/api/src/common/interceptors/request-id.interceptor.ts
- apps/api/src/main.ts
- apps/web/app/login/page.tsx
- apps/web/lib/api.ts
- apps/web/lib/auth-messages.ts
- tests/unit/auth-error-diagnostics.test.ts (new)
- tests/unit/csrf-injection.test.ts
- tests/unit/firebase-config.test.ts
- tests/unit/web-auth-api.test.ts
- docs/authentication-endpoint-diagnostics.md (this file)

## Frontend/security contract

All browser requests remain same-origin through Next rewrites, with credentials include. API requests are explicitly no-store. CSRF bootstrap returns csrfToken, sets cf_csrf, and the client sends x-csrf-token on mutations. Cache invalidation on 401/CSRF_FAILED is retained with no automatic mutation replay. Google and Telegram controls appear only when discovery reports them configured. Loading, discovery failure, and retry are explicit; password remains available on discovery failure because password authentication is supported independently. Error messages distinguish ORIGIN_FORBIDDEN from CSRF_FAILED and retain correlation IDs. Session errors also show their request IDs.

Cookie settings remain HttpOnly, SameSite=Lax, Path=/, Secure in production. No origin bypass, mock successful login, hardcoded runtime secret, database reset, migration or user deletion was introduced. Telegram routes were not rewritten.

## Executed HTTP tests

Using the **actual registered AuthController**, real SessionService, real FirebaseService, real TelegramOidcService, real SessionAuthGuard/CsrfGuard and production origin policy/filter/middleware. Unused AuthService and Telegram notification dependencies are inert; database login/session issuance and Redis rate limiting are NOT exercised by this fixture.

The same route checks passed directly and through the actual running Next dev server at port 3000 proxying to isolated Nest on port 4000:

| Route | Verified result |
| --- | --- |
| GET /api/auth/providers | 200; password true, unconfigured OAuth false |
| GET /api/auth/csrf | 200; real signed token/cookie validated |
| GET /api/auth/session | 200 authenticated:false, including conditional GET |
| POST /api/auth/login | missing/invalid CSRF rejected; valid token + invalid input reaches 400 VALIDATION_FAILED |
| POST /api/auth/logout | anonymous caller 401 with correlated request ID |
| POST /api/auth/bootstrap | missing CSRF rejected; valid token + invalid input 400 |

Invalid Origin rejected with 403 directly and through proxy. No successful authentication or persisted session is claimed from these negative-path checks.

Commands executed:

- `CSRF_PROXY_TEST=1 npx vitest run --config tests/vitest.config.ts tests/unit/csrf-injection.test.ts`: **7 passed**, including all six route checks through Next.
- Full unit suite with randomly generated temporary process-only SESSION_SECRET: **218 passed, 1 skipped across 29 files** before adding the separate diagnostic-log regression. The opt-in proxy test was separately passed above. Final aggregate rerun after that addition: **219 passed, 1 skipped across 30 files**; API build passed again after the filter change.
- New diagnostic-log regression: **1 passed**; confirms sanitized 500, correlation identity and structured error frames without raw sensitive message.
- API and frontend TypeScript checks passed. Root ESLint passed (the existing lint script covers the web workspace).
- `npm run build:apps`: API and Next production app builds passed. Packages were compiled individually after engine-free Prisma generation; no working native database runtime is implied.
- `npm run test:integration`: **4 suites failed, 19 skipped**. Firebase-auth/database/storage suites cannot load absent root .env; notifications cannot connect without DATABASE_URL. No live auth integration pass.

## Configuration / Windows next verification

No .env was created or changed. There is no evidence about the content of the user's Windows .env. Keep existing SESSION_SECRET and encryption key on an existing deployment; do not rotate them casually.

Required base configuration remains documented in .env.example: NODE_ENV, APP_URL=http://localhost:3000, API_PORT=4000, ALLOWED_ORIGINS including exactly http://localhost:3000, TIMEZONE, DATABASE_URL, REDIS_URL, REDIS_PREFIX, SESSION_SECRET (at least 32 characters), CREDENTIAL_ENCRYPTION_KEY (base64 32-byte key), ADMIN_BOOTSTRAP_TOKEN, storage settings, WORK_DIR, AI/video URLs and API keys. Local storage requires STORAGE_LOCAL_ROOT and STORAGE_LOCAL_PUBLIC_BASE_URL. Keep production HTTPS/Secure cookies and explicit allowlists.

Optional Google: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or a valid FIREBASE_SERVICE_ACCOUNT_JSON; browser FIREBASE_WEB_API_KEY, optional FIREBASE_WEB_AUTH_DOMAIN/FIREBASE_WEB_APP_ID. Server verification and browser configuration must both exist before enabled=true. Existing strict startup validation still rejects split credential pairs instead of silently weakening configuration.

Optional Telegram login: TELEGRAM_LOGIN_CLIENT_ID + TELEGRAM_LOGIN_CLIENT_SECRET, optional TELEGRAM_LOGIN_REDIRECT_URI (otherwise /api/auth/telegram/callback on APP_URL). Notification bot credentials are separate. None are necessary for password discovery/CSRF. No provider completion has been verified without real credentials.

From C:\projects\youtube_automation-master, install/generate/build packages with normal native Prisma engines, then restart `npm run dev:api` and `npm run dev:web` from the updated checkout. Confirm the API command uses scripts/dev-api.cjs rather than tsx or stale dist. Do not run multiple old API instances on port 4000. Match a failing browser request's ID to API log errorType/frames before attributing either 500 to a specific service. Compare a fresh anonymous request with one carrying the existing session cookie; do not publish cookie contents.

**Remaining blockers:** real credential login, session cookie persistence across reload, authenticated logout/revocation, valid administrator bootstrap, live Redis limiting and real provider flows remain unverified without the configured Windows infrastructure/account. Complete authentication is not declared restored until those pass.
