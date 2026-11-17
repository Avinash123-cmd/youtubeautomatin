# Temporary local development access

This feature does **not** authenticate a browser, create a user, issue a session or turn off production authentication. Telegram login remains intact.

## Enable

Use a disposable local PostgreSQL database containing an **existing** active developer membership in a dedicated workspace whose slug starts with `dev-auth-bypass-`. Do not select production/user workspaces. The bypass does not create or rename accounts/workspaces or seed fake data.

Set these in the API development environment (no secrets or local `.env` files were changed by this implementation):

```dotenv
NODE_ENV=development
AUTH_BYPASS=true
AUTH_BYPASS_USER_ID=<existing-developer-user-uuid>
AUTH_BYPASS_WORKSPACE_ID=<existing-dedicated-sandbox-workspace-uuid>
DATABASE_URL=postgresql://<local-credentials>@127.0.0.1:5432/<disposable-local-database>
```

Set `AUTH_BYPASS=true` for **Next dev** too. Run the existing API and web development commands (`npm run dev:api`, `npm run dev:web`) with their normal required service configuration, and restart both after changing the flag. On Windows PowerShell, set `$env:AUTH_BYPASS='true'` in each terminal. Set Next's `API_INTERNAL_URL` to the actual local API origin if necessary; the browser continues using relative URLs/proxy routes, never a browser-side localhost backend URL.

Do not set `NODE_ENV=development` to run a production deployment. `next build` / `next start` are production-mode commands and intentionally do not enable this bypass. A dashboard build with AUTH_BYPASS=true still built successfully with production gating intact.

A PostgreSQL hostname other than `localhost`, `127.0.0.1` or `[::1]` is rejected. Container users must deliberately expose their **disposable local database** on a loopback port; the application does not allow arbitrary network database hosts as a convenience. This protects against accidentally pointing development access at a hosted DB, but cannot inspect what a loopback SSH tunnel forwards to: never tunnel production DBs into this mode.

## Scope and security

The shared policy requires exact `AUTH_BYPASS=true`, NODE_ENV development/test, and absence of hosted-runtime flags (VERCEL, RENDER, NETLIFY). Production always returns false. It is evaluated on the server; no public NEXT_PUBLIC bypass toggle or browser identity is trusted.

- The shell opens all application pages directly, including refresh/direct job URLs, without session-check/loading or login redirects. Development mode is visibly labelled **not signed in**. Direct login routes go to the dashboard in this mode.
- Session-info returns `authenticated:false, developmentAccess:true` and the actual selected sandbox membership/configuration—not fake successful authentication. No auth cookies/session records are created by the bypass.
- API reads for dashboard, sources, jobs, clips/media, accounts, publishing history/calendar, usage, notifications, configuration/activity/brand profiles and operator status can use the selected sandbox membership. Original workspace filters and role requirements remain; MEMBER does not become ADMIN.
- Source uploads/imports, job creation/cancellation/non-publishing retries and clip metadata edits/download auditing can run in that sandbox. Job creation requires explicit autoPublish=false. Retry checks the persisted configuration; auto-publishing jobs cannot be retried via bypass.
- Publishing, OAuth/account mutations, security identity/session actions, operator/configuration/notification mutations are **not** granted bypass. Those actions still need a verified login. Account-security page explicitly explains that limit instead of fetching private session/identity controls anonymously. Other genuine API errors remain visible; controls are not faked to succeed.
- Session and unrelated auth endpoints, callbacks, webhook secrets, resource ownership, role checks, input validation, CORS/origin policy and rate limiting are unchanged. Unsafe bypass requests still require the existing signed anonymous CSRF cookie/token pair; no CSRF skip was introduced.
- Use only local development credentials/storage and synthetic or authorized test media. Existing integrations are not altered. Do not expose a bypass-enabled API to untrusted users: anyone who can reach it can act within the configured development scope. This is not a network access-control replacement.

## Disable / restore Telegram login

Set `AUTH_BYPASS=false` (or unset it) in API and web environments, then restart both development servers. Delete no users, sessions or data. Normal login gating and API 401 behavior return. Sign-out is disabled and labelled in bypass mode because there is no bypass session to revoke. To test real authentication/security or publishing flows, turn bypass off first.

## Verification performed

- Dependency install: npm ci passed; no dependency or lockfile changes.
- Full production build (packages, NestJS, Next): passed with AUTH_BYPASS=true. Sandbox-only Prisma engine-free generation and `/bin/true` engine overrides were necessary for restricted engine downloads; these are NOT deployment instructions or DB-runtime proof.
- Full unit suite: **506 passed, 3 skipped, 68 files**, including 44 new tests.
- New tests cover development/production/disabled/hosted gating, required sandbox membership, remote-DB rejection, scope, role preservation, publishing restrictions, trailing-slash safety, retry restrictions, and frontend shell direct URLs.
- Actual Nest HTTP harness using real guards, anonymous CSRF and CORS: dashboard read/refresh without auth cookie succeeds with isolated repository fixture; missing CSRF rejects mutations; signed anonymous CSRF allows scoped writes; rate limiter remains active; disallowed origins and publishing reject; production/disabled flag returns 401. Repository and rate-limit service are isolated test doubles, not real PostgreSQL/Redis integration proof.
- Actual Next development HTTP checks: `/` twice (refresh), `/jobs`, direct `/jobs/<uuid>`, `/clips`, `/create`, `/settings`, `/accounts`, `/calendar`, `/videos`, `/publishing`, `/security` all returned 200 with development banner and without authentication loading/redirect content. Test server stopped afterward.
- Lint passed without warnings; diff whitespace check passed.

## Remaining blockers

No local PostgreSQL/Redis runtime or configured developer sandbox membership was available for full real-data API/browser E2E. The Next smoke check verifies actual server-rendered pages, not hydrated browser API requests. Backend absence remains visible rather than being hidden by fake successful responses. A developer must provide the existing sandbox membership and normally required local services/environment before testing real processing. Production deployment was not changed and no content was published.
