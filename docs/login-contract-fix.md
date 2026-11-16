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


## Follow-up: undefined schema `.safeParse()` — 2026-11-16

### Root cause and reproduction

This is a different failure from an omitted `missing` array. Both `botProvidersResponseSchema` and
`botLoginStatusResponseSchema` are correctly named exported Zod instances in validation's source
index. That index imports Zod and shared-types; its domain re-export imports shared-types only as a
type. No dependency points back to validation; no circular schema initialization was found.

The workspace has no `exports` map, and its `main`/`types` entry points are generated
`dist/index.js` / `dist/index.d.ts` (CommonJS ES2022 TypeScript output). Next has no validation source
alias. Before this repair, app-local dev/build/typecheck scripts did not rebuild validation. An
existing old dist could therefore provide undefined new schema exports, despite correct source
imports. A clean checkout has no dist at all. Root `npm run build` did build packages first, but
`npm run dev:web` and app-local build commands did not. Vitest source aliases masked this boundary.

Reproduction in this sandbox: build the package, replace only its ignored generated JS with a stale
export fixture, load it in a fresh Node process: botProvidersResponseSchema is undefined. Run the
new web predev hook: both schemas again expose safeParse and accept valid provider/IDLE payloads.
The original Windows artifact cannot be inspected here; its exact contents are not independently
proven. The stale-artifact failure mechanism is reproduced, not inferred from an API JSON error.

### Repair and files

- `apps/web/package.json`, `apps/api/package.json`: predev/prebuild/pretypecheck refresh validation
  before consuming it, including direct workspace commands.
- `packages/validation/package.json`: prebuild builds shared-types first; shared-types is correctly
  declared a runtime dependency rather than dev-only, since index imports its constants at runtime.
- `package-lock.json`: synchronized dependency classification.
- `tests/unit/validation-package-entry.test.ts`: three regression tests verify unaliased Node
  resolution and initialized Zod exports from both apps, valid/invalid safeParse responses, optional
  diagnostics normalization and lifecycle wiring.
- `packages/validation/README.md` and this report: build entry, lifecycle and restart guidance.

No duplicate import, unsafe assertion, schema fallback, source/dist split or auth contract change was
introduced. Login property access was reviewed: the sole missing.join is reached only after runtime
schema validation, which defaults absent arrays and rejects malformed/null arrays. Identity is
validated by the VERIFYING discriminated state; genuine API errors remain displayed. Existing
regression tests cover missing and malformed properties, so no extra page change was needed.

### Actual checks

- Targeted schemas, runtime package entry, login render/state, API/client and bot service tests:
  **80 passed, 1 proxy case skipped** across 7 files.
- Full unit suite: **323 passed, 2 opt-in cases skipped**, 40 files, with isolated test-only
  SESSION_SECRET. No root .env created or overwritten.
- Both opt-in suites subsequently passed against production Next: **17/17 bot HTTP** and
  **7/7 CSRF**. Providers and Telegram status returned 200; CSRF-protected challenge creation returned
  201 using the isolated test provider (not a live database/Telegram challenge).
- Frontend/API TypeScript checks, ESLint, API compilation and production Next build passed.
- Production `/login` HTTP smoke check: **200**, initial IDLE state, no SSR crash.
- Generated Prisma engine-free client was used only for compilation/tests, not DB verification.

Live Telegram authentication, real challenge persistence and interactive browser verification remain
unperformed without configured services/credentials. No successful authentication was fabricated.
On Windows stop existing dev processes and use `npm run dev:web` / `npm run dev:api`; for production,
run `npm run build` before starting the new artifact. Do not bypass npm lifecycle hooks.
