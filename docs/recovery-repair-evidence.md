# Recovery repair checkpoint — 2026-11-16

This is a bounded implementation checkpoint for the full-project completion request, not a certification that the entire application is complete.

## Root causes and changes

- Processing transitions previously read and updated without a PostgreSQL row lock. State transitions now lock the processing row; worker-driven transitions check current lease ownership and expiry under that lock. Expired leases cannot be renewed by a stale owner.
- Pipeline rendering handoff and retry outbox writes previously committed separately from their state changes. Both are now transactional, including delayed retry timestamps (minimum 15 seconds).
- Recovery trusted an earlier sweep snapshot, unconditionally cleared leases and could bypass retry budgets for partial renders. Recovery now rechecks current state/lease under lock, consumes the recovery budget, and writes state and render/pipeline outbox intents in the same transaction. Zero-ready renders resume rendering; all-ready output gets a finalization delivery. A fresh heartbeat prevents repeated recovery before delivery.
- Publishing recovery now locks/reloads the publishing row and respects an active lease before changing state. This does not establish provider-side exactly-once delivery or verify external publishing reconciliation.
- Recovery sweeps cannot overlap within one process. Database row locking also serializes different processes.
- Cancelled and failed stage rows preserve their actual outcome. Terminal transitions clear ownership. Mixed manual render results become PARTIALLY_COMPLETED; failed parents are not advanced by render finalization.

## Fresh verification

- `npm ci`: passed; no dependency upgrades in this checkpoint.
- `npm run check:typescript`: passed, TypeScript 5.9.3 across workspaces.
- `npm run build:api`: ordinary Prisma generation blocked by the sandbox engine download restriction. Repeated with sandbox-only engine-free Prisma generation and `/bin/true` engine overrides: passed. These overrides are NOT deployment settings and do not prove DB runtime behavior.
- `SESSION_SECRET=<test-only value> npx vitest run --config tests/vitest.config.ts`: **439 passed, 3 skipped, 61 files** after API compilation. Includes 15 new transactional recovery/state regressions. Initial direct run before compilation/test configuration failed three tests (missing compiled startup artifact and test session secret); fixed invocation prerequisites, not hidden.
- `npm run lint`: passed.
- No real PostgreSQL/Redis/storage or provider credentials configured; no migration, live concurrency, authenticated workflow, actual media render or publishing acceptance executed. Mocked transaction tests verify ordering, guards, intent data and error propagation, not SQL isolation or actual rollback.

## Deployment observations

Fresh public URL fetches during this checkpoint:
- `https://youtubeautomation-mauve.vercel.app/healthz`: commit `d090266`, correct `https://youtubeautomatin.onrender.com` target, `UPSTREAM_TIMEOUT` after approximately five seconds. The previous missing-target sentinel is resolved in that deployed build; API availability is not.
- `https://youtubeautomatin.onrender.com/api/system/live`: Render application-loading HTML, not API JSON. No successful API readiness verified.

No deployment performed. No user data, identity settings or root `.env` changed. Telegram-only authentication remains intact. No content published. Remaining broad project work, split-service media paths, native service acceptance and release blockers in the foundation audit remain outstanding.
