> **Historical document:** authentication is now Telegram Bot-only. Google, password, OIDC and email recovery routes are not registered. Do not follow legacy provider-enablement steps; see [telegram-bot-only-auth.md](telegram-bot-only-auth.md).

# Authentication hardening — implementation and verification

## Scope and root cause

This checkout already contained Firebase/Google login, Telegram OIDC, Telegram bot deep-link linking,
OTP step-up/recovery, Prisma models/migrations, the premium split-panel login screen, and account
settings. This change extends that architecture rather than introducing another auth system.

Confirmed defect: `main.ts` passed a plain `Error` to the CORS callback when an Origin was not in
`ALLOWED_ORIGINS`. The catch-all filter classified that as an internal failure (500). The previous
policy compared literal strings, so an otherwise equivalent configured trailing slash did not match.
The replacement emits structured 403 `ORIGIN_FORBIDDEN`, validates configuration, normalizes origins,
and confines optional wildcards to explicit HTTPS subdomains. `*` is never accepted. localhost and
127.0.0.1 remain different origins and must be configured separately. Missing Origin is permitted for
non-browser clients, safe navigation and provider callbacks; unsafe application routes still require
CSRF. Telegram webhooks instead require the provider secret header.

The Windows `.env` mentioned in the request is not accessible from this Linux checkout, which has no
root `.env`. Its actual configured values cannot be diagnosed here. No claim is made that an existing
Windows environment was inspected or changed. Previously the loader searched the process working
directory and `../../.env`. It now selects the repository root relative to its own module location,
independent of startup directory. A fresh-Node-process test verifies loading and injected-variable
precedence. Node minimum is now 20.12, the version introducing `process.loadEnvFile`.

### Measured proxy behavior

Production Next server on port 3000, using the existing rewrite to a temporary header-only Express
probe on port 4000:

```
Browser Origin                  upstream Origin                 upstream Host    X-Forwarded-Host
http://localhost:3000            http://localhost:3000           127.0.0.1:4000   localhost:3000
http://127.0.0.1:3000            http://127.0.0.1:3000           127.0.0.1:4000   localhost:3000
```

Origin is preserved. Host/forwarded-host are not security allow-list inputs. The probe was removed
and both temporary servers stopped. Its JSON response was not an application CSRF test.

## Security changes

- CSRF response is `no-store`; the signed anonymous cookie is HttpOnly (JS receives the token via JSON).
- Login, bootstrap, Firebase exchange, recovery, resend and step-up POST routes now use the global CSRF guard; only safe GETs and authenticated machine webhooks are exempt.
- Unhandled exception messages no longer leak to clients; server logging remains available.
- Legacy manual-chat-ID link endpoints return `TELEGRAM_BOT_LINK_REQUIRED`. The old completion
  accepted a separately supplied chat ID not bound to its challenge. No users/links are deleted.
- `/security` now uses the same one-time bot deep-link connection as `/settings`, with pending,
  connected, Verify Telegram/refetch, and disconnect states.
- OTP delivery rechecks persisted Telegram bot connection before sending. Arbitrary supplied chat
  IDs cannot receive codes. Existing manual links must reconnect through the bot if not activated.
- OTP issuance locks the user row, enforces per-channel/purpose cooldown including consumed codes,
  invalidates predecessors, and creates a complete HMAC-hashed challenge in one transaction.
- Verification locks challenge rows in a stable order so attempt accounting and one-time consumption serialize.
- DUAL completion requires exactly the account's current channel set. All supplied codes validate before
  any are consumed; an incorrect sibling does not waste a correct code.
- Firebase and Telegram identity verification both enforce local OTP policy before issuing sessions.
  Provider redirects hand off via an encrypted HttpOnly, SameSite=Lax, short-lived cookie with a
  constrained API path, not challenge IDs in URLs or an authenticated session.
- Resend updates the challenge IDs used by the login UI and the provider handoff cookie.
- First-admin bootstrap takes a PostgreSQL transaction-scoped advisory lock and rechecks user count.
- Session validation rejects the exact expiration boundary as well as already expired sessions.
- Recovery delivery/cooldown errors retain the same public response as unknown email addresses.
- Concurrent browser mutations share one initial CSRF fetch; structured provider 503 errors are no
  longer mislabeled as an unreachable backend.
- Removed the hardcoded OTP secret fallback. OTP_SECRET or SESSION_SECRET must have 32+ characters.
- `/link` aliases `/connect`; `/unlink` aliases `/disconnect`. Linking opens the signed-in security
  page. Unlink commands direct users to that page rather than silently disabling a required factor.
- Registration adds Google/Telegram actions and password confirmation. Existing login/recovery
  design is preserved. Provider buttons do not bypass server-side signup policy.
- CSRF bootstrap failures preserve the structured origin/configuration message in the web client.

## Database and endpoints

No new migration or schema change is needed. Existing migrations, including
`20261116140000_unified_telegram_auth`, already provide provider IDs, unique constraints, OIDC
transactions, connection tokens and OTP records. No reset, deploy or data migration was executed.
Run the existing unapplied migrations normally; do not reset an existing database.

No parallel authentication system was added. Two small endpoints support provider OTP handoff:

- GET `/api/auth/security/otp/pending` — decrypted, unexpired pending step-up metadata from its
  authenticated-encryption cookie; `no-store`; never creates a session.
- POST `/api/auth/security/otp/cancel` — clears that cookie; protected by normal CSRF and rate limiting.

Relevant existing endpoints:

- GET `/api/auth/csrf`, `/providers`, `/session`
- POST `/api/auth/bootstrap`, `/register`, `/login`, `/firebase`, `/logout`
- GET `/api/auth/telegram`, `/api/auth/telegram/callback`
- POST `/api/auth/telegram/webhook` (Telegram secret-header authentication)
- POST `/api/auth/security/telegram/connect`, `/telegram/unlink`
- POST `/api/auth/security/telegram/link/start`, `/telegram/link/complete` (retained but retired safely)
- POST `/api/auth/security/otp/step-up/complete`, `/otp/resend`
- POST `/api/auth/security/forgot-password`, `/reset-password`
- PUT `/api/auth/security/otp-mode`

## Local configuration

Copy `.env.example` to the repository-root `.env`, fill the existing required database/storage/service
and cryptographic settings, and use:

```dotenv
NODE_ENV=development
APP_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
API_PORT=4000
```

To browse using both loopback names, explicitly add `http://127.0.0.1:3000` to ALLOWED_ORIGINS.
For direct host processes, DATABASE_URL/REDIS_URL/service URLs must use reachable host ports, not
Compose service DNS names. API_INTERNAL_URL can override the Next rewrite target; its local default
is `http://127.0.0.1:4000`. Rebuild the frontend after changing its build-time proxy configuration.
Keep SESSION_SECRET and CREDENTIAL_ENCRYPTION_KEY stable to preserve sessions/encrypted credentials.

### Telegram setup

1. Create/select a bot with BotFather. Obtain TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME (no @).
2. Generate a random TELEGRAM_WEBHOOK_SECRET (16–256 URL-safe characters, preferably 32+).
3. In BotFather's login configuration, register the public web origin and exact callback URL. Obtain
   TELEGRAM_LOGIN_CLIENT_ID (numeric) and TELEGRAM_LOGIN_CLIENT_SECRET; they are distinct from the bot token.
4. Set TELEGRAM_LOGIN_REDIRECT_URI to `https://YOUR_WEB_HOST/api/auth/telegram/callback`. Production
   requires HTTPS and this callback must be on APP_URL. Default derives this path from APP_URL.
5. Opt into TELEGRAM_LOGIN_ALLOW_NEW_USERS=true only if public Telegram signup is intended; otherwise
   accounts must already be associated. ALLOW_SELF_REGISTRATION and FIREBASE_ALLOW_NEW_USERS have
   their own separate policies.
6. Register the webhook using the existing authenticated admin Telegram settings, or Telegram's
   `setWebhook` API **from a trusted server**, setting URL to
   `https://YOUR_PUBLIC_HOST/api/auth/telegram/webhook` and `secret_token` to TELEGRAM_WEBHOOK_SECRET.
   Do not paste bot tokens into frontend code or browser URLs. Ensure the proxy forwards the
   `X-Telegram-Bot-Api-Secret-Token` header. Telegram cannot call localhost; use a real HTTPS deployment.
7. Sign in → Security → Connect Telegram → Open Telegram bot → press Start → Verify Telegram.
   Only after this succeeds enable Telegram OTP. OIDC login alone does not activate bot delivery.
8. Register `/start`, `/link`, `/status`, `/help`, `/unlink` in BotFather's command menu if desired.

Official protocol documentation checked via search retrieval on this run:
https://core.telegram.org/bots/telegram-login — authorization `https://oauth.telegram.org/auth`, token
`https://oauth.telegram.org/token`, JWKS `https://oauth.telegram.org/.well-known/jwks.json`, issuer
`https://oauth.telegram.org`, code flow, S256 PKCE and server-side Basic client authentication.
Existing implementation validates signature, issuer, audience, expiry, nonce, state/browser cookie,
and atomically consumes the transaction. No live Telegram exchange was attempted.

Google requires the existing FIREBASE_PROJECT_ID, server service account (FIREBASE_SERVICE_ACCOUNT_JSON
or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY), FIREBASE_WEB_API_KEY, FIREBASE_WEB_AUTH_DOMAIN and
FIREBASE_WEB_APP_ID. Enable Google in Firebase Authentication and authorize the web domain.
Email recovery requires SMTP_HOST, SMTP_FROM and the SMTP port/security/credentials for your provider.
Optional OTP_SECRET, OTP_TTL_SECONDS, OTP_RESEND_COOLDOWN_SECONDS, OTP_MAX_ATTEMPTS already exist;
these names are unchanged. No secrets were added to the repository.

## Startup commands

```sh
npm ci
# Full stack (database, Redis, API/web, FastAPI and workers):
docker compose -f docker-compose.dev.yml up --build
# Apply existing migrations in the configured API container:
docker compose -f docker-compose.dev.yml exec api npm run db:deploy
```

Alternatively, with PostgreSQL, Redis and dependent services already running, in separate terminals:

```sh
npm run db:generate
npm run build:packages
npm run db:deploy
npm run dev:api
npm run dev:web
# Optional workers, each separately:
npm run worker:ai
npm run worker:render
npm run worker:publish
npm run worker:scheduler
npm run worker:recovery
```

## Executed verification and remaining gates

| Check | Actual result |
|---|---|
| npm ci | Passed |
| Backend + frontend TypeScript | Passed |
| npm run lint | Passed; repository defines an ESLint script for web only |
| Unit suite | **175 passed, 21 files**, with SESSION_SECRET set to a non-production test value |
| New Nest HTTP tests | Actual production CSRF controller + session helper, global filter, CORS policy and CSRF guard in an isolated Nest app: 200 token; valid mutation; missing/invalid token 403; invalid Origin 403 |
| Root env subprocess test | Passed from root, API directory, unrelated cwd; injected values win |
| OTP lifecycle | Stubbed transactional repository tests passed: expiry, replay, wrong/malformed code, max attempts, unlinked delivery rejection, cooldown, predecessor invalidation, atomic dual-channel consumption and exact policy enforcement |
| Existing OIDC signature/claim tests | 10 passed within unit suite |
| Prisma schema validation | Passed using bundled schema validator; no database connection |
| Prisma client generation | Passed engine-free; normal engine download is blocked by network policy |
| Database package tsc | Passed after engine-free generation |
| npm run build:apps | Passed API compilation and Next production build after final changes |
| GET http://localhost:3000/login | HTTP 200 from production Next server; no interactive browser/provider verification |
| Real Next rewrite header preservation | Passed via temporary upstream probe, as recorded above |
| Existing integration suite | Attempted, **4 suites failed**, 19 tests skipped; missing root .env/database/runtime engine. Not passed |
| Frontend auth client tests | 5 tests passed in the shared Vitest suite: concurrent CSRF fetch, origin errors, provider 503, proxy errors, expired-session CSRF reset. No standalone frontend test script exists |
| Bot linking/webhook boundary | 8 stubbed-repository/controller tests passed for secret checks, private sender validation, expiry, replay, duplicate connection, atomic consumption loss and command behavior |
| Provider OTP + handoff | Provider policy tests and cookie confidentiality, tamper, expiration and clearing tests passed |
| Session continuity | 5 repository-stub tests passed for valid existing session, expiry, revocation, disabled user and legacy CSRF |
| Migration deployment | Not run: no PostgreSQL service/credentials; no new migration to deploy |

Run the unit suite with a disposable test secret (never a production credential):

```sh
SESSION_SECRET=unit-test-only-secret-at-least-32-characters npx vitest run --config tests/vitest.config.ts
```

Normal `npm run build` / `npm run test:unit` first regenerate Prisma with its native engine. This
sandbox cannot reach binaries.prisma.sh. No fake engine or engine-free setting was committed. Run
normal generation in the target environment before using the application database client.

**Not end-to-end verified:** actual email/password login, first-admin bootstrap, database-backed expired sessions,
Google login, Telegram OIDC callback, webhook secret rejection/live account linking, duplicate/reused
link behavior against PostgreSQL, bot availability/delivery, email recovery, transaction concurrency
under real database load, existing session continuity. They require configured services, provider
credentials and a public Telegram webhook. Treat these as release gates, not successful tests.

## Exact changed files

- `.env.example`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/otp.service.ts`
- `apps/api/src/auth/pending-step-up.ts`
- `apps/api/src/auth/security.controller.ts`
- `apps/api/src/auth/security.service.ts`
- `apps/api/src/auth/session.service.ts`
- `apps/api/src/auth/telegram-account.service.ts`
- `apps/api/src/common/filters/all-exceptions.filter.ts`
- `apps/api/src/common/origin-policy.ts`
- `apps/api/src/load-env.ts`
- `apps/api/src/main.ts`
- `apps/web/app/login/page.tsx`
- `apps/web/app/register/page.tsx`
- `apps/web/app/security/page.tsx`
- `apps/web/lib/api.ts`
- `apps/web/lib/hooks.ts`
- `docs/authentication-overhaul.md`
- `package-lock.json`
- `package.json`
- `tests/unit/auth-security.test.ts`
- `tests/unit/load-env.test.ts`
- `tests/unit/origin-csrf.test.ts`
- `tests/unit/otp-lifecycle.test.ts`
- `tests/unit/pending-step-up.test.ts`
- `tests/unit/provider-step-up.test.ts`
- `tests/unit/session-validation.test.ts`
- `tests/unit/step-up-policy.test.ts`
- `tests/unit/telegram-linking.test.ts`
- `tests/unit/web-auth-api.test.ts`
