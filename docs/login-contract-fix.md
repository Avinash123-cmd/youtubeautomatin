# Telegram login crash and API contract fix — 2026-11-16

## Findings

The sole `.join()` in the login page was `providers.data.telegram.missing.join(', ')`. A TypeScript API generic did not validate runtime JSON; an omitted diagnostic `missing` array could crash rendering when Telegram was disabled. The backend normally includes this field, but older/incomplete responses and cached data were not safe. The page now consumes a shared runtime-validated contract: omitted optional diagnostics normalize to `[]`, invalid types produce an actionable contract error, and absent details show an operator fallback. This is not a blanket optional-chaining workaround.

`GET /api/auth/telegram/status` already exists in BotAuthController, is public, and is registered by AuthModule. No duplicate endpoint was added. It uses the opaque HttpOnly browser challenge cookie, not an authenticated user session, and is read-only. Direct Nest HTTP and real Next rewrite tests return 200/IDLE without a challenge cookie. The Windows 404 cannot be reproduced against this route here; the exact process/proxy serving that response is unknown. A stale/wrong API or build-time rewrite target is a hypothesis, not a proven cause. Likewise session 304 is inconsistent with current auth no-store/ETag protections, which remain intact.

## Contract and implementation

- `packages/validation/src/index.ts`: shared providers, discriminated status, challenge and completion schemas.
- `apps/web/lib/bot-auth-api.ts`: validates unknown JSON; preserves API errors/request IDs; explains incompatible responses and status 404.
- `apps/api/src/auth/bot-auth.controller.ts`: validates existing providers/status outputs; response validation failures are server errors, not invalid client input. Optional `contractVersion: telegram-bot-v1` identifies provider metadata.
- Providers: Telegram enabled/configured comes from actual bot configuration, never hardcoded true; password/self-registration cannot be advertised as active. Optional missing diagnostics default only when absent, not when malformed.
- Status: IDLE or EXPIRED; WAITING_FOR_TELEGRAM with ISO expiresAt; VERIFYING with ISO expiresAt and display identity. No session is created by GET.
- Challenge: HTTPS t.me bot URL with validated login payload and expiry. Completion: authenticated=true and CSRF token, followed by successful session restoration before dashboard navigation.
- `apps/web/app/login/page.tsx` and `lib/bot-login-state.ts`: validate cached data, explicit seven-phase state marker, gated/no-retry polling, bounded countdown, expiry/new-link and connection retry handling. Polling stops on errors, expiry or authentication. No alternate sign-in UI.
- `apps/web/lib/api.ts` and `auth-messages.ts`: null JSON/CSRF error handling and useful configuration/contract/session diagnostics.
- Regression coverage: bot-auth-contract, bot-login-render, bot-login-state, bot-auth-http and web-auth-api unit tests.

## Verification

- Frontend and API typechecks: passed. Workspace ESLint: passed.
- Full unit suite: **320 passed, 2 skipped, 39 files** with an isolated test-only SESSION_SECRET supplied to the process. Initial run without that required variable: 319 passed, 1 failed, 2 skipped (crypto HMAC configuration requirement). No .env was created or changed.
- The two opt-in proxy cases subsequently ran successfully: bot HTTP **17/17**, CSRF **7/7**, using a production Next server and isolated Nest test application with test doubles. These are not live Telegram/DB proofs.
- API and web production builds: passed. Structure verification: 81 checks passed. Diff whitespace check: passed.
- HTTP smoke check: production `/login` returned 200 and initial data-auth-state=IDLE. Static/render tests cover missing/malformed responses and all seven state mappings. No interactive browser automation was available; no claim of manual clicking or real Telegram success is made.

## Operator follow-up / remaining release gates

In the Windows checkout, rebuild/restart both API and frontend from the same revision. Verify direct API `/api/auth/providers`, `/api/auth/session`, `/api/auth/telegram/status`, then the same routes through Next. Inspect the actual request host, status, response body and request ID. API_INTERNAL_URL must target the Nest API origin (not the notification-status route). Next rewrites are compiled at build time, so changing this variable requires a rebuild; restarting an old production build is insufficient.

Required configuration includes TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, optional TELEGRAM_BOT_ID, database/Redis/session secrets. Webhook registration requires TELEGRAM_WEBHOOK_SECRET and a reachable public HTTPS TELEGRAM_WEBHOOK_URL ending in `/api/auth/telegram/webhook`; never register localhost. Follow [existing bot setup](existing-telegram-bot-setup.md).

Real challenge creation, Telegram Start/deep-link delivery, callback confirmation, atomic database consumption, session cookies and dashboard navigation still require configured credentials, services and a real browser. They were not exercised here. No database reset/migration, user/account merging, secret logging, root .env overwrite, CSRF relaxation or unrelated pipeline change was performed.
