# Telegram bot-only authentication implementation

## Phase 0: dependency map and audit (2026-11-16)

Browser -> Next rewrites -> Nest CORS/origin policy -> cookie parser -> SessionAuthGuard -> Redis rate limit -> CsrfGuard -> auth controllers -> SessionService/PostgreSQL. Sessions are shared across all modules; no replacement session architecture is needed.

Current auth: AuthController exposes password/bootstrap/registration/Firebase/Telegram OIDC; SecurityController exposes public email password reset/recovery-code/OTP session paths. TelegramAccountService implements signed-in one-time bot linking; NotificationsService exports a bounded Bot API client, webhook registration/status and delivery results. User has distinct unique telegramLoginId (legacy OIDC) and telegramUserId (bot), nullable passwordHash, required email. User email/profile/history records and legacy provider columns must be preserved. OIDC subject cannot be assumed equivalent to Bot API numeric sender ID.

New dependency: hashed login challenge + independent hashed browser verifier -> authenticated private /start webhook -> identity resolution + approval in one transaction -> browser POST completion -> existing SessionService in same transaction. GET status must never create sessions. Bot and browser secrets must be distinct, neither stored plaintext. Existing linking must participate in the same identity lock as login. Legacy session-issuing routes must be unregistered, including email recovery. Historical implementation code may remain unregistered for migration evidence/tests, not as an active fallback.

Known failures: prior tsx injection failure repaired before this branch. Current CSRF/provider HTTP 500s were not reproduced in the prior branch; missing OAuth settings are not a demonstrated cause. Session conditional caching and lost request IDs were repaired. Current environment lacks root .env and configured infrastructure; do not infer the Windows .env contents.

Risks/release gates: existing unlinked users will lose new login access unless linked using an existing session before expiry or explicitly migrated with separately verified ownership. No email-based automatic merge. Preserve existing sessions. Additive Prisma migrations only. Real PostgreSQL migration/race execution, Redis throttling and real Telegram webhook/login must pass before production cutover. No credentials or .env will be authored. No AI/video/publishing changes.

## Phase execution log and gates

| Phase | Changes / files | Validation and status |
| --- | --- | --- |
| 0 Audit | dependency map above; controller/provider/schema/frontend/deployment/test search | existing paths inspected before edits |
| 1 Environment/startup | common/env.ts, .env.example, Compose | typechecks; absent bot in dev produces explicit discovery status; production requires all bot credentials and HTTPS APP_URL; full configured stack unavailable |
| 2 CSRF/discovery | BotAuthController; shared SessionService | active-controller HTTP tests pass; real signed cookie, origin rejection, no alternative providers; previous Windows 500s not reproduced here |
| 3 Challenges | TelegramBotLoginService, new challenge model | random/hashing/expiry/rotation/status repository-stub tests pass; no real PostgreSQL concurrency proof |
| 4 Webhook | BotAuthController, existing TelegramAccountService | secret validation, private sender matching, malformed updates, retry dedup tests pass; no real Telegram update received |
| 5 Accounts | TelegramBotLoginService | stub tests cover existing bot identity and transactional new OWNER workspace; migration/collision races not run live |
| 6 Sessions | existing SessionService accepts transaction client; BotAuthController.complete | real crypto with repository stubs; handoff consumption/session write share transaction; no live persisted browser login |
| 7 Optional OTP | existing OtpService plus authenticated BotSecurityController | existing OTP crypto/attempt/cooldown/consumption tests plus ownership/delivery/action tests pass; never authenticates or recovers by email; actual Telegram delivery unavailable |
| 8 Frontend | login page and bot-login-state helper | SSR/render/state tests, actual Next HTML, web typecheck/lint/build pass; no full browser interaction/mobile viewport E2E |
| 9 Retire providers | AuthModule registers only bot controllers; legacy pages redirect; hooks/Firebase SDK/button/CSP removal | active module test + legacy POST routes 404; historical source/tests/columns retained deliberately, not active fallbacks |
| 10 Security settings | BotSecurityController, security/settings/shell UI | IDOR/unlink/OTP tests and typecheck/build pass; live account actions await infrastructure |
| 11 Database | additive 20261116000000_telegram_bot_login migration | schema validation passes; migration deployment/real DB integrity test BLOCKED |
| 12 Security | state separation, dedup, locks, bounded serializable retries, secret-safe config; fixed tenant webhook destination | unit/HTTP tests pass; real DB/Redis/load review still required |
| 13 Integration | bot-auth-http tests, actual Next rewrites | bot proxy 16 passed; retained isolated CSRF proxy 7 passed; database integration 4 failed suites/19 skipped due absent environment |
| 14 Build/deployment | production app builds, operator CLI, docs | builds pass; real provider/deployment workflow NOT verified |

Code-only phases progressed with isolated tests. The database/provider-dependent phases remain release gates, not completed validations. No production deployment or migration was attempted. No users, existing identities, sessions, workspaces, subscriptions or videos were deleted. No video/AI/publishing implementation was changed.

## Active API contracts

- GET `/api/auth/providers`: password=false, selfRegistrationEnabled=false, providers=[TELEGRAM_BOT], telegram.enabled/configured/missing. `enabled` means settings are present, NOT a verified external service-health claim. No Firebase/OIDC discovery dependency.
- GET `/api/auth/csrf`: unchanged `{csrfToken}` plus signed HttpOnly `cf_csrf` cookie. Originless safe GET follows existing policy; explicit disallowed origins get 403.
- POST `/api/auth/telegram/challenge`: CSRF + IP throttled; returns deepLink/expiresAt. A separate HttpOnly `cf_bot_login` cookie binds the browser. Only hashes stored. A later challenge rotates the same browser row and invalidates the prior deep link. Concurrent initial requests with no prior binding can leave unclaimable orphan rows; frontend single-flight and IP limits bound this, but strict cross-tab initial-request dedup is not claimed.
- GET `/api/auth/telegram/status`: cookie-only lookup, IDLE/WAITING_FOR_TELEGRAM/VERIFYING/EXPIRED, expiry and approved display identity. Does not consume or create a session. No challenge IDs/lookup secrets in URLs or JS storage.
- POST `/api/auth/telegram/complete`: CSRF + browser binding, explicit identity confirmation in UI; atomically consume challenge and issue the existing ClipForge session; sets HttpOnly `cf_session`, clears binding cookie; JSON includes authenticated and csrfToken, never raw session token. A prior authenticated session is revoked after successful handoff.
- POST `/api/auth/telegram/webhook`: secret header mandatory, update schema validated. Login only accepts a non-bot sender in a matching private chat. Login approvals and update dedup commit together; linking also deduplicates in its token-consumption transaction. Informational commands deduplicate before best-effort replies.
- GET `/api/auth/session`: existing shared-session/workspace/readiness contract; real verified bot link determines authMethods. Existing unlinked sessions remain valid and receive a migration warning in the shell.
- POST `/api/auth/logout`: authenticated + CSRF, DB revocation errors no longer swallowed.
- GET `/api/auth/security/overview`: own verified identity, last login, sessions, history, security events. Exposed device row IDs are non-bearer database identifiers, never session cookie secrets.
- POST `/api/auth/security/telegram/link/start` (and existing `/telegram/connect` alias): current-session-only deep link via existing linking service. `/link/complete` never trusts browser identity and explains that Start in the bot is required.
- POST `/api/auth/security/telegram/unlink`: always 409 ONLY_IDENTITY_REQUIRED. No alternate-provider bypass or unsafe disconnect control.
- DELETE `/api/auth/security/sessions/:id`, POST `/sessions/revoke-all`: own-account scoped and CSRF protected; history/audit displayed.
- POST `/api/auth/security/otp/request`, `/otp/resend`, `/otp/verify`: authenticated, CSRF protected, account AND IP throttled. Telegram-only optional action verification; purpose SESSION_REVOCATION. Resend invalidates prior code, observes existing OTP_* cooldown; invalid/expired/replayed codes fail. Verify consumes the code and revokes all sessions; it never issues a session or resets a password. Delivery failure is 503, never reported as sent. OTP consumption and subsequent revocation are separate existing-service transactions: a revocation failure requires a fresh code; no success is reported. UI only shows a code field after requesting this specific optional action.

Retired routes (not registered, no fallback): `/api/auth/login`, `/firebase`, `/register`, `/bootstrap`, legacy GET `/telegram` and `/telegram/callback`, public email password reset, recovery-code redemption, public OTP session completion. Old source files and direct class regression tests are historical migration/reference artifacts; they are not in AuthModule's active provider/controller graph. The browser Firebase package/client/button and unused alternative-auth hooks were removed. Backend firebase-admin remains solely because historical unregistered sources/tests still compile; removing that archive/dependency is deferred cleanup, not an active provider.

## Database / identity preservation

Migration: `packages/database/prisma/migrations/20261116000000_telegram_bot_login/migration.sql`.

Adds TelegramBotLoginChallenge (unique tokenHash/browserHash; approval, consumption, expiry; nullable User FK/index), TelegramBotUpdate (BIGINT unique update_id + timestamp/index), and SESSION_REVOCATION to the existing OtpPurpose enum. Existing tables/columns/data are retained. Prisma UUID defaults are generated by the client. No reset, drop, user deletion or rewrite of historical provider identity was performed. Schema validation is not migration execution.

Identity resolution matches **only verified bot telegramUserId**. Do not treat legacy OIDC `sub` as a numeric Bot API ID. Never match email, username, display name, phone or profile email to attach an identity. New users receive a random reserved .invalid alias for the required legacy email field, not a deliverable or verified address; it is hidden from session profile responses. No fake password is stored. New users get an OWNER membership and workspace; business processing configuration remains explicitly unconfigured rather than populated with demo values.

Serializable transactions with bounded conflict retries, unique constraints and a per-bot-ID PostgreSQL advisory lock protect account creation. Existing linking uses the same identity lock. Browser handoff consumption is conditional and shares the session-write transaction. **These controls are tested with repository stubs, not proven under real PostgreSQL concurrency here.** Validate them against a disposable/staging database before release. Historical session continuity should be verified with a pre-cutover fixture.

### Existing-account migration / recovery

1. Back up and verify a restore before cutover. Inventory active users with no bot link, and conflicts between legacy OIDC subjects and verified bot IDs. Do not publish personal data in logs.
2. Users with an existing authenticated ClipForge session must open Security and press Connect Telegram **before that session expires**. This proves ownership of the existing account while the authenticated bot update proves the new identity.
3. An unlinked user who starts the new login flow can create a separate account. No automatic merge is allowed. Communicate this clearly and stage migration before enabling broad registration/cutover. This implementation does not infer or resolve lost ownership from matching emails.
4. If no valid session remains, the operator needs a separately verified recovery/migration process. **No automated lost-Telegram recovery or identity-replacement workflow is implemented.** Email, old passwords and historical recovery codes cannot authenticate through this application.
5. A verified administrative migration must check unique identity ownership, preserve the existing user/workspace IDs, revoke outstanding sessions/challenges, and audit the change. No unsafe public admin-recovery endpoint or default administrator was introduced. The first new bot account owns its own workspace; workspace ownership is not permission to redirect the shared identity bot.

## Threat model highlights and remaining risks

- Forged Telegram IDs: no browser identity contract; secret-authenticated private webhook sender only.
- Webhook forgery: constant-time shared-secret comparison before update dispatch; trusted deployment controls webhook destination. Correct registration/secret secrecy still depends on deployment.
- Tenant account takeover via bot settings: fixed shared-bot registration; workspace owners cannot send secret_token to a tenant-chosen URL or discard pending auth updates.
- Token guessing/theft/replay: 256-bit opaque token, SHA256 at rest, 5-minute default, single approval, independent HttpOnly browser verifier, single consumption, explicit identity confirmation. A stolen deep link alone cannot claim the browser session; never share links. Cross-device social engineering/login swapping is mitigated by explicit account review, not magically eliminated.
- Duplicate updates/concurrent logins: DB uniqueness, transactional dedup/consumption, serializable retries and identity locks. Live race tests remain required.
- Session fixation: fresh existing-session infrastructure; raw tokens only HttpOnly cookies, production Secure, SameSite=Lax; old session revoked on authenticated replacement.
- CSRF/origin: guards preserved; only authenticated machine webhook bypasses CSRF. GET status never creates sessions. Proxy/cookie contract tested locally.
- IDOR/workspace isolation: own-session context for linking/device/OTP actions; shared SessionAuthGuard remains global for all application modules, ignores deleted workspaces when selecting memberships.
- OTP: existing secure code generation/HMAC/attempt/expiry/lock/cooldown, forced verified Telegram channel, purpose-bound to own-account revocation. No OTP values in responses/logs; no unauthenticated OTP recovery.
- Enumeration: no public lookup by Telegram ID/email; status needs browser secret. `/status` bot command is visible only to its authenticated sender.
- Retention/abuse: challenge/update rows need a measured retention job and load testing before large-scale deployment. IP throttles are Redis-backed; live Redis execution/cluster behavior is unverified. Multi-tab initial challenge strict dedup, complete-browser races and webhook failure/retry soak testing remain gates.

## Required environment and startup

Existing shared environment still requires NODE_ENV, APP_URL, API_PORT, ALLOWED_ORIGINS, TIMEZONE, DATABASE_URL, REDIS_URL, REDIS_PREFIX, SESSION_SECRET (32+ chars), CREDENTIAL_ENCRYPTION_KEY (32-byte base64 key), storage/work paths and AI/video endpoint/key settings. The shared parser has not been split into auth-only and worker profiles: AI/video services need not be running to generate a token, but their required environment values are still a startup coupling. Removing that config coupling is deferred; no unrelated AI/video implementation was modified.

Authentication credentials:

```dotenv
TELEGRAM_BOT_TOKEN= # BotFather token; server secret
TELEGRAM_BOT_USERNAME= # without @
TELEGRAM_WEBHOOK_SECRET= # independent 16–256 character A-Z/a-z/0-9/_/- secret
# Public HTTPS tunnel/deployment origin; exact route required
TELEGRAM_WEBHOOK_URL=https://your-public-host/api/auth/telegram/webhook
TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS=300
# Existing OTP policy reused; no duplicate TELEGRAM_OTP_* variables
OTP_TTL_SECONDS=300
OTP_RESEND_COOLDOWN_SECONDS=60
OTP_MAX_ATTEMPTS=5
# Optional separate 32+ character secret; otherwise existing SESSION_SECRET is used
OTP_SECRET=
```

Never paste actual secret values into documentation/chat, pass them as CLI arguments, log them, commit .env, or rotate existing session/encryption secrets casually. Dev without Telegram config returns disabled provider status and actionable challenge errors; production refuses startup without bot token/username/secret and HTTPS APP_URL. Existing strict bot token/username/secret format validation is retained. ADMIN_BOOTSTRAP_TOKEN is no longer required or usable through an active route. Retired OAuth env fields may remain accepted for historical tests, but are not consulted by provider discovery and are removed from active Compose/template setup.

### BotFather / webhook operations

1. Create a dedicated ClipForge bot with BotFather `/newbot`; store its token server-side. Confirm the configured username belongs to the token. Do not configure Telegram Login/OIDC or Google/Firebase.
2. Set commands: start, link, status, help, unlink. Start with a test bot in staging.
3. Expose `/api/auth/telegram/webhook` over a trusted HTTPS reverse proxy. Local development needs an operator-provided HTTPS tunnel to port 4000 (or the frontend proxy), with the exact public URL in TELEGRAM_WEBHOOK_URL. The same secret check is required locally. Keep browser APP_URL and ALLOWED_ORIGINS consistent, e.g. http://localhost:3000; 127.0.0.1 is a different origin.
4. Run `node scripts/register-telegram-auth.cjs --check-config` for format checks, then `node scripts/register-telegram-auth.cjs`. The operator CLI reads the existing root .env without overwriting injected environment, verifies getMe username, calls setWebhook with secret_token and allowed_updates=[message], never drops pending updates, and verifies getWebhookInfo. It prints only safe status, no token/secret/deep-link/session values. No session is required, avoiding a first-login bootstrap deadlock.
5. Do not run getUpdates long polling on this bot while webhook delivery is enabled. Verify TLS, proxy body/header forwarding, Telegram reachability and webhook error status before inviting users.
6. `/start login_<opaque>` approves a pending login and tells the user to return to ClipForge; invalid/expired login tokens never create accounts/sessions. `/start <opaque>` consumes an existing authenticated-account link. `/link` directs users to signed-in Security; `/status` reports their own connection; `/help` explains commands; `/unlink` directs to protected migration guidance and cannot remove the sole identity. Informational replies are best effort; an OTP rejected by Telegram is never called delivered.

Official references checked using search: https://core.telegram.org/bots/features (deep-link start payload is URL-safe, at most 64 characters); https://core.telegram.org/bots/api#setwebhook (HTTPS, secret_token and X-Telegram-Bot-Api-Secret-Token); https://core.telegram.org/bots/api#update (update_id and retries). login_ + 43-character base64url fits the documented payload limit. No real Telegram Bot API call was possible in this sandbox.

### Local commands (after configuring real infrastructure)

```sh
npm ci
npm run build:packages
# BACK UP and test migration on staging first; deploy applies migrations, never reset
npm run db:deploy
node scripts/register-telegram-auth.cjs --check-config
node scripts/register-telegram-auth.cjs
npm run dev:api
# another terminal
npm run dev:web
```

Use the existing API tsc-backed launcher, not tsx for Nest HTTP. Existing database migrations must be present in order; do not run prisma migrate reset. Review the additive migration and test concurrent login/linking against an isolated staging database. Production: build normal native Prisma engines and app images, deploy database migration before API code, inject credentials as deployment secrets, route HTTPS frontend/API/webhook correctly, register the deployment bot with the CLI, verify readiness and the real workflow below, then enable traffic. Compose now injects required bot credentials/TTL/webhook URL and no retired provider credentials. Docker deployment itself is unverified here.

## Verification evidence

- Final full unit run: **271 passed, 2 skipped across 37 files**. Skips are opt-in proxy tests, both separately executed successfully.
- `BOT_PROXY_TEST=1 npx vitest run --config tests/vitest.config.ts tests/unit/bot-auth-http.test.ts`: **16 passed**, actual Next rewrite, real controller/guard/cookie/origin implementations. Challenge service is explicitly stubbed in this isolated HTTP fixture; database/service crypto paths are tested separately with repository stubs. This is NOT a persisted real login pass.
- `CSRF_PROXY_TEST=1 npx vitest run --config tests/vitest.config.ts tests/unit/csrf-injection.test.ts`: **7 passed**. Historical isolated-controller CSRF regression, not proof retired routes are active.
- New service tests: **14**; browser state **6**; login rendering **5**; OTP/security actions **7**; shared webhook destination **3**; dual rate budgets **2**. Includes missing/invalid webhook secret, malformed update, private sender checks, replay/expiry, existing/new identity, no password creation, consumed handoff, session crypto, blocked unlink, IDOR and failed delivery.
- Actual Next `/login` HTML fetched: Telegram-only layout present, no password field or Google button. Interactive viewport/accessibility/mobile and real browser redirect/persistence E2E were not executed.
- API/web TypeScript checks and root ESLint passed. `npm run build:apps` passed API and optimized Next production builds, repeated after implementation changes.
- Prisma schema structurally validated with compilation-only engine overrides; engine-free generated client used for TypeScript/tests. This is not normal native-engine/database verification. No migration applied.
- `npm run test:integration`: **4 suites failed, 19 skipped** (missing root .env/DATABASE_URL). Authentication database integration is not passed.
- `python3 tests/e2e/full_workflow.py`: failed explicit preflight (no real Telegram-authenticated session cookie/video fixture). The existing pipeline E2E now requires a disposable Telegram-linked session supplied securely by environment; it no longer attempts password login and does not pretend to test Telegram authentication.
- `node scripts/register-telegram-auth.cjs --check-config`: failed safely with missing credentials, no network request/secrets logged. Actual registration/getMe/webhook delivery not executed.
- `git diff --check`: passed. No servers intentionally left running after verification.

Repeat full units with a temporary process-only test SESSION_SECRET (do not replace a deployment's real secret). The root pretest hook builds native Prisma packages, so the direct Vitest command above was used after compiling packages with an explicitly engine-free client in this restricted environment.

### Mandatory real-bot release acceptance (NOT executed)

On an isolated test deployment with a genuine test bot, database and Redis: create the challenge in the real browser; open the actual deep link and press Start; verify Telegram delivered the authenticated webhook; confirm the displayed identity; POST completion; inspect HttpOnly/Secure cookie policy without copying tokens to logs; open dashboard; reload and restore the same user/workspace; logout and verify the cookie no longer authenticates. Repeat for an existing prelinked account, expiry, duplicate/replayed updates, simultaneous login/linking, Telegram blocked/unavailable, OTP resend/attempt/replay, existing-session migration, workspace IDOR, and DB/Redis outages. Verify migration preservation and backup restore. None of these external acceptance results may be inferred from unit tests.

## A–F completion classification

- **A — implemented and tested locally:** active Telegram-only module/retired-route rejection; real CSRF/cookie/origin boundary; hash separation; challenge state/expiry/replay logic with repository stubs; active-controller HTTP + actual Next proxy; frontend SSR/state/error/expiry; identity-only resolution and same-transaction session design with stubs; IDOR/unlink/delivery protection; server-controlled webhook destination; typechecks/lint/app builds.
- **B — implemented awaiting Telegram credentials:** getMe/registration verification, real private /start proof, login notice, OTP delivery, existing-account linking through real bot.
- **C — implemented awaiting external deployment configuration:** public HTTPS/tunnel, secret injection, proxy/TLS delivery, production cookie confirmation, Docker deployment and monitoring.
- **D — partial:** transaction/race correctness not exercised on PostgreSQL; optional OTP-to-revocation spans two transactions (fails safely, may require a fresh OTP); strict cross-tab first-challenge dedup; full browser interaction/mobile/accessibility E2E; migrations/retention/load verification; fully decoupled auth-only environment; historical backend provider source/dependency cleanup.
- **E — not implemented:** automated lost-Telegram recovery/identity replacement or secure operator migration UI; automatic account merge (intentionally forbidden); background challenge/dedup retention job.
- **F — externally blocked:** normal native Prisma runtime, live PostgreSQL/Redis tests/migration validation, genuine Telegram and full end-to-end persisted login/logout. No root .env or user Windows infrastructure is available here.

**Not production-ready / definition of done not met:** do not deploy this cutover to existing users until the migration/recovery communication, database tests and real-bot acceptance gates above are completed.

Structure validation initially reported the two deliberately retired controllers and two previously unindexed reports. The structure rule now explicitly fails if either historical controller is re-registered (rather than exempting arbitrary orphans); reports are indexed. Rerun: **81 checks passed, 0 failed**.

## Exact cumulative modified files

- `.env.example`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/bot-auth.controller.ts`
- `apps/api/src/auth/bot-security.controller.ts`
- `apps/api/src/auth/bot-session-description.ts`
- `apps/api/src/auth/otp.service.ts`
- `apps/api/src/auth/session.service.ts`
- `apps/api/src/auth/telegram-account.service.ts`
- `apps/api/src/auth/telegram-bot-login.service.ts`
- `apps/api/src/common/decorators/rate-limit.decorator.ts`
- `apps/api/src/common/env.ts`
- `apps/api/src/common/guards/rate-limit.guard.ts`
- `apps/api/src/notifications/notifications.service.ts`
- `apps/web/app/forgot-password/page.tsx`
- `apps/web/app/login/page.tsx`
- `apps/web/app/register/page.tsx`
- `apps/web/app/security/page.tsx`
- `apps/web/app/settings/page.tsx`
- `apps/web/components/google-button.tsx`
- `apps/web/components/shell.tsx`
- `apps/web/lib/bot-login-state.ts`
- `apps/web/lib/firebase-client.ts`
- `apps/web/lib/hooks.ts`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `docker-compose.dev.yml`
- `docker-compose.prod.yml`
- `docs/AUTH-SECURITY.md`
- `docs/DOCUMENT-INDEX.md`
- `docs/FIREBASE-AUTH.md`
- `docs/FOLDER-STRUCTURE.md`
- `docs/PRODUCTION-READINESS.md`
- `docs/TELEGRAM-AUTH.md`
- `docs/authentication-endpoint-diagnostics.md`
- `docs/authentication-overhaul.md`
- `docs/telegram-bot-only-auth.md`
- `package-lock.json`
- `packages/database/prisma/migrations/20261116000000_telegram_bot_login/migration.sql`
- `packages/database/prisma/schema.prisma`
- `scripts/check-firebase.sh`
- `scripts/check-structure.sh`
- `scripts/register-telegram-auth.cjs`
- `tests/README.md`
- `tests/e2e/full_workflow.py`
- `tests/unit/bot-auth-http.test.ts`
- `tests/unit/bot-login-render.test.ts`
- `tests/unit/bot-login-state.test.ts`
- `tests/unit/bot-rate-budgets.test.ts`
- `tests/unit/bot-security-actions.test.ts`
- `tests/unit/bot-webhook-registration.test.ts`
- `tests/unit/firebase-config.test.ts`
- `tests/unit/telegram-bot-login.test.ts`
- `tests/unit/telegram-linking.test.ts`
- `tests/unit/telegram-notifications.test.ts`
- `tests/unit/web-security-headers.test.ts`
- `tests/vitest.config.ts`

## Existing-bot follow-up

See [existing-telegram-bot-setup.md](existing-telegram-bot-setup.md) for optional Bot ID pinning, read-only getMe verification, localhost/private URL rejection, the operator command modes, Windows tunnel setup, and the latest actual test evidence. Real credentials/tunnel/database remain unavailable in this sandbox; no real authentication success is claimed.
