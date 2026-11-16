# CSRF endpoint repair — 2026-11-16

## Diagnosis

The repository's `dev:api` invoked `tsx watch src/main.ts`. tsx/esbuild does not emit TypeScript `design:paramtypes` metadata, even with `emitDecoratorMetadata` configured. Nest therefore instantiated AuthController without its implicit constructor dependencies. GET `/api/auth/csrf` called `this.sessions.issueAnonymousCsrf()` on an undefined dependency and returned 500. The dependency-free liveness handler could still succeed.

Reproduced using NestFactory with the **actual registered AuthController**, not a prototype call: HTTP 500 before the repair; HTTP 200 after explicit injection. This reproduces a concrete repository defect consistent with the reported symptoms. The Windows machine and its original request-ID logs were not accessible, so this does not independently establish what command or stack trace that machine used.

The previous origin/CSRF tests manually supplied `sessions` to a prototype call, masking the injection failure. The new regression test lets Nest construct the controller under a metadata-free transform.

## Changes

- `apps/api/src/auth/auth.controller.ts`: explicit injection tokens for all five constructor dependencies.
- `apps/api/package.json`: use the compiler-backed development launcher instead of tsx for the HTTP API.
- `scripts/dev-api.cjs`: compile with TypeScript watch (retaining metadata throughout the application), start/restart Node only after zero-error compilation; forward shutdown to child processes. No new dependencies.
- `apps/web/lib/api.ts`: explicitly bypass caching for CSRF bootstrap; invalidate rejected CSRF state on structured CSRF_FAILED 403, without automatically replaying mutations.
- `tests/unit/csrf-injection.test.ts`: actual controller construction, cookie signature verification, origin rejection, missing/invalid/valid tokens on the real login route, and opt-in actual Next rewrite check.
- `tests/unit/web-auth-api.test.ts`: test invalidation and no automatic mutation replay.
- `docs/csrf-endpoint-repair.md`: this report.

## Dependency/security trace

Request: CORS policy → cookie parser → session guard → rate-limit guard → CSRF guard → controller → SessionService → cryptographic randomBytes/HMAC → Express cookie/JSON.

A fresh anonymous safe GET requires neither a Redis command nor a database query. If a session cookie is supplied, the global session guard still validates it against the database; a database outage is not fixed by this change. Rate limiting applies to login POST, not this undecorated GET. Safe GET may omit Origin per existing policy; an explicit disallowed Origin still receives 403 ORIGIN_FORBIDDEN. Host/forwarded-host are not origin trust anchors.

Anonymous CSRF uses 24 random bytes and an HMAC-SHA256 signature with SESSION_SECRET. Response remains `{ csrfToken }`; cookie remains `cf_csrf=token.signature`, HttpOnly, SameSite=Lax, Path=/, one-hour expiry, Secure in production. Response is no-store. Anonymous POST must send both cookie and `x-csrf-token`. Session tokens remain derived from session identity. No secrets, bypasses, new fake tokens, or security exemptions were added.

There is no evidence that the reported Windows configuration was missing. In this checkout there is no root .env. Existing startup validation explicitly rejects absent/short SESSION_SECRET and other required settings, before serving requests; no fallback secret was introduced. The repaired dev launcher compiled successfully and then refused startup with the explicit missing-key report, as expected here.

Frontend uses relative /api URLs, credentials include, csrfToken response property, and x-csrf-token header. Concurrent initial mutations share one bootstrap. Existing 401 invalidation is retained, with CSRF_FAILED invalidation added. Authentication screens already replace the anonymous token with the returned session token. Next rewrites remain unchanged and forward cookies, Origin and CSRF headers.

## Executed verification

- Before fix: actual-controller regression returned 500 instead of 200. Initial run also encountered missing Prisma native engine errors; test-only generation with `--no-engine` removed those errors. This is not a database runtime validation.
- Actual controller GET without Origin: 200, signed token/cookie verified.
- Actual controller GET with Origin http://localhost:3000: 200.
- Explicit invalid Origin: 403 ORIGIN_FORBIDDEN.
- POST actual /api/auth/login with missing token: 403.
- Same POST with invalid token: 403.
- Same POST with valid signed cookie/token and invalid body: 400 VALIDATION_FAILED, proving it passed CSRF into real login schema validation, **not successful authentication**.
- Next dev server on port 3000, isolated actual Nest controller on port 4000: GET token 200; cookie/signature verified; valid-cookie/header POST reached login validation; invalid Origin through proxy returned 403. Opt-in run: **4 tests passed**.
- Full unit suite: **209 passed, 1 skipped across 29 files**. The skipped proxy test was separately executed successfully above. Initial full run without SESSION_SECRET had one crypto-test failure; rerun used a randomly generated temporary test-only process value, no .env written.
- API and web typechecks, API build, web ESLint, diff check: passed.
- Compiler-backed dev launcher: zero compilation errors; Node started compiled application, rejected missing environment explicitly. Full server not healthy/configured in this checkout.

Repeat proxy check while Next dev is running:

```sh
CSRF_PROXY_TEST=1 npx vitest run --config tests/vitest.config.ts tests/unit/csrf-injection.test.ts
```

The test owns port 4000 and requires it free. It uses real SessionService crypto and AuthController, but deliberately replaces unrelated external providers with inert dependencies. It does not test persistence or issue a fake successful login.

## Remaining release gate / Windows verification

**Complete real authentication is NOT verified or claimed restored end-to-end.** This sandbox cannot access `C:\projects\youtube_automation-master\.env`, the user's database/Redis, or a real account. Native Prisma engines also remain unavailable here. Configure the existing root .env with real infrastructure (do not replace SESSION_SECRET on an existing deployment), install/generate the normal native Prisma client, and run:

```powershell
cd C:\projects\youtube_automation-master
npm run build:packages
npm run dev:api
# separate terminal, same repository
npm run dev:web
```

Use one browser origin consistently: `http://localhost:3000` must appear explicitly in ALLOWED_ORIGINS. `http://127.0.0.1:3000` is distinct; add it only if actually used. Do not set production merely for local HTTP (Secure cookies require HTTPS). Production must retain HTTPS and Secure cookies.

In the browser, verify token GET 200 + HttpOnly cookie, actual credential login (and OTP if enabled), cf_session issuance, session-token replacement and authenticated GET /api/auth/session. Redis rate limiting and real database session writes must succeed. A valid-token request reaching body validation is not a substitute for that release gate.
