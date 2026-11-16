# Connect an existing Telegram bot to ClipForge

## Current execution status — 2026-11-16

The existing Telegram-only implementation was inspected and reused. No second auth module was added. Active controllers remain BotAuthController/BotSecurityController; identity comes from the authenticated private-chat webhook, not browser Telegram IDs. Login challenges, account resolution, session handoff, commands and optional Telegram security OTP are documented in [telegram-bot-only-auth.md](telegram-bot-only-auth.md).

**This sandbox has no root .env and none of TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_ID, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_WEBHOOK_URL, DATABASE_URL or REDIS_URL in its injected environment. It cannot access C:\projects\youtube_automation-master\.env.** Real Telegram outbound access is also outside this sandbox's allowed network hosts. Therefore no real getMe, webhook registration or complete real login was performed. Do not paste the bot token in chat. Configure and run the operator commands on your Windows machine or deployment with Telegram access.

## What this follow-up repaired

- The existing operator tool can now run read-only `--verify-bot` and `--status`, separately from `--register` and offline `--check-config`.
- getMe verifies the bot username and numeric ID against the bot token prefix, plus optional TELEGRAM_BOT_ID. Mismatch prevents registration. Bot ID is an identity pin, not a replacement credential or a browser identity assertion.
- All operator requests target the official HTTPS Bot API, reject redirects, have a 10-second timeout, and sanitize failures. No token/secret/upstream exception text appears in output.
- Registration preserves pending updates, allows only message updates, and includes the configured secret_token. It checks getWebhookInfo afterward, but explicitly does not claim real authentication verification from registration alone.
- API startup validation, tenant registration and operator setup now reject localhost, IP literals (including IPv6/abbreviated IPv4), local/internal hostnames, invalid ports, wrong paths, embedded credentials and query strings. Use a public HTTPS hostname. This is syntactic validation, not proof DNS resolves publicly, TLS works, or Telegram can deliver.
- Optional TELEGRAM_BOT_ID is supported in the root template and Compose. A supplied ID inconsistent with the token prefix fails startup without exposing either value.
- Root environment loading was tested in a fresh process from a different working directory; injected values retain precedence.

## Exact environment variables

Edit only the relevant entries in the **existing root** `C:\projects\youtube_automation-master\.env`. Preserve the database URL, existing encryption/session secrets, storage configuration and all other working settings. Do not replace the whole file with this excerpt. Values in angle brackets are placeholders, not working credentials.

```dotenv
APP_URL=http://localhost:3000
API_PORT=4000
ALLOWED_ORIGINS=http://localhost:3000
TELEGRAM_BOT_TOKEN=<your existing BotFather token>
TELEGRAM_BOT_USERNAME=<your existing bot username without @>
# Optional, recommended: the numeric Bot ID you already have
TELEGRAM_BOT_ID=<your numeric Bot ID>
TELEGRAM_WEBHOOK_SECRET=<independent cryptographically random URL-safe secret>
TELEGRAM_WEBHOOK_URL=https://<your public HTTPS tunnel hostname>/api/auth/telegram/webhook
TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS=300
```

The webhook secret must be independently generated (16–256 characters from A–Z/a–z/0–9/_/-), not the bot token. Store it privately, not in logs or chat. Existing `SESSION_SECRET` (32+ characters) protects session/CSRF tokens. Database and Redis must be configured. Existing OTP_TTL_SECONDS=300, OTP_RESEND_COOLDOWN_SECONDS=60, OTP_MAX_ATTEMPTS=5 and optional OTP_SECRET are reused; no duplicate OTP configuration is needed.

The bot token is server-only. Bot ID is optional because getMe is always compared with the ID prefix already embedded in the token. No Bot ID is accepted as browser authentication proof.

## Local HTTPS tunnel

Start Nest on port 4000 and Next on port 3000. Run your trusted HTTPS tunnel to **http://localhost:4000**, not to PostgreSQL/Redis. For example, with an already-installed tunnel client:

```powershell
ngrok http 4000
# OR
cloudflared tunnel --url http://localhost:4000
```

These clients are not installed or executed by this change. Obtain the actual public HTTPS hostname they assign, and set:

`TELEGRAM_WEBHOOK_URL = <that HTTPS origin> + /api/auth/telegram/webhook`

**The exact route is `/api/auth/telegram/webhook`; the exact hostname is pending your tunnel URL. No localhost URL has been registered.** Do not configure `https://localhost`, private/IP destinations, `/api/api/...`, or a tunnel access page requiring browser login. Keep the browser at localhost:3000; Telegram calls the tunnel independently and does not need browser cookies. Preserve the webhook secret header at every proxy. Restart Nest after changing env. A rotating tunnel hostname requires updating env and re-registering. Do not expose local development without the webhook secret check.

## Operator commands (PowerShell)

```powershell
cd C:\projects\youtube_automation-master
# Reuse the existing bot; this is read-only and needs only token/username (+ optional ID).
node scripts/register-telegram-auth.cjs --verify-bot

# After setting the independent secret and public tunnel URL:
node scripts/register-telegram-auth.cjs --check-config
node scripts/register-telegram-auth.cjs --register
node scripts/register-telegram-auth.cjs --status
```

The script loads root .env by its own location, not the current shell directory. It does not overwrite injected variables. `--verify-bot` invokes getMe only. `--check-config` makes no network call. `--status` invokes getMe/getWebhookInfo but never changes registration; it requires the expected URL/secret configuration so it can compare the destination. Default invocation retains the prior registration behavior, so prefer an explicit flag. All output is safe booleans/counts or fixed actionable error codes; do not share other logs containing credentials.

`registered`/`destinationMatches` means Telegram accepted/reported the destination, not that a real login or secret delivery was verified. The Bot API does not return the saved secret_token; test it through an actual authenticated webhook. No pending updates are dropped. Stop any long-polling getUpdates process using this bot before webhook deployment.

## Existing login/startup path

With normal native Prisma engines and your configured database, first back up and test the existing additive migration on staging; never reset an existing database:

```powershell
npm ci
npm run build:packages
npm run db:deploy
npm run dev:api
# Separate terminal in the same root:
npm run dev:web
```

The migration adds hashed challenge/dedup tables and the optional action OTP purpose; it preserves users/workspaces/history. It has NOT been applied or verified against a real database in this sandbox. API sessions remain the existing HttpOnly cf_session infrastructure. Production requires HTTPS APP_URL, Secure cookies, all bot credentials and the public webhook. The registration CLI can be run by the deployment operator before any user signs in.

Commands already implemented and reused:

- `/start login_<token>` approves a short-lived challenge from the login page; the browser must then explicitly confirm the displayed identity and POST completion.
- `/start <link-token>` securely links to an already authenticated existing account.
- `/link` directs the user to authenticated ClipForge Security; it cannot bind arbitrary user IDs.
- `/status` reports only the authenticated Telegram sender's connection status.
- `/help` explains supported commands; `/unlink` directs to safe migration guidance and cannot disconnect the only identity.

For old ClipForge users, link through an existing signed-in session **before it expires**. Do not start a new-account login and expect an email/name match to merge the accounts. There is no email/password/Google/OIDC fallback, and lost-identity migration needs separately verified operator handling.

## Complete real authentication acceptance — still required

1. Run `--verify-bot`, configure the tunnel, register and inspect webhook status.
2. Open http://localhost:3000/login. Check provider discovery and CSRF return 200 with signed cookie; wrong explicit Origin must still fail.
3. Continue with Telegram, open the returned link and press Start in the real bot. Confirm the application received a secret-authenticated private-chat update and approved only the matching challenge.
4. Return to ClipForge, verify the displayed identity, and confirm. Check HttpOnly session cookie creation without copying it into logs.
5. Open dashboard, reload, confirm the same existing/new user and correct workspace, then logout and verify revocation.
6. Test expired/replayed challenges, duplicate webhook updates, missing/wrong webhook secrets, blocked bot delivery and concurrency on a disposable staging database. Validate existing-account preservation before cutover.

No claim of complete success is made until those pass against the real bot/database/browser.

## Tests actually executed in this follow-up

- New operator/env/URL validation tests: **20 passed**, using isolated mocked Telegram responses. One initial assertion used an unsupported test matcher; corrected and rerun successfully.
- Full suite: **291 passed, 2 skipped across 38 files**. Temporary process-only test SESSION_SECRET; no root .env written. Both opt-in proxy tests were separately executed successfully.
- Actual Next rewrite with isolated Nest controllers: bot HTTP suite **16 passed**; CSRF regression **7 passed**. Tests do not prove real Telegram delivery or database persistence.
- API and web TypeScript checks: passed. Root ESLint: passed.
- API/Next production app builds: passed. Package compilation used explicitly engine-free Prisma client generation in this restricted sandbox; not proof of native database runtime.
- `node scripts/register-telegram-auth.cjs --verify-bot`: stopped safely with CONFIGURATION_REQUIRED; no credentials present, no real Telegram request made.
- Database integration attempted: **4 failed suites, 19 skipped**, missing root .env/DATABASE_URL.
- Repository structure: **81 passed, 0 failed**. `git diff --check`: passed. Test servers were stopped.

## Exact additional files changed by this follow-up

- `.env.example`
- `apps/api/src/common/env.ts`
- `apps/api/src/common/telegram-webhook-url.ts` (new)
- `apps/api/src/notifications/notifications.service.ts`
- `docker-compose.dev.yml`
- `docker-compose.prod.yml`
- `scripts/register-telegram-auth.cjs`
- `tests/unit/telegram-bot-setup.test.ts` (new)
- `docs/existing-telegram-bot-setup.md` (this document)
- `docs/telegram-bot-only-auth.md` (follow-up link)
- `docs/DOCUMENT-INDEX.md`

Earlier Telegram-only cutover files were preserved, not replaced with duplicate modules. The broader cumulative list remains in the cutover report.
