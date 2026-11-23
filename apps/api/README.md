# `apps/api` — backend API and workers

NestJS application. It owns the domain, the database, and every queue. Nothing else writes to
PostgreSQL.

## Layout

```
src/
├── main.ts                 bootstrap: pino logger, request ids, cookies, Swagger at /api/docs
├── app.module.ts           module registry + global guards (rate limit → session → CSRF)
├── auth/                   login, logout, sessions, CSRF issuing, Argon2id hashing
├── jobs/                   processing jobs: create, list, cancel, retry, stage timeline
├── sources/                chunked upload, direct-URL import (SSRF-guarded), YouTube URL ingest
│   └── youtube/            yt-dlp runner, oEmbed preview, source creation and download
├── clips/                  clip list/detail, per-platform metadata, download registration
├── publishing/             enable/disable auto-publish, publish jobs, history, retry
├── accounts/               OAuth connect/callback/verify/disconnect (tokens encrypted at rest)
├── media/                  Range-capable object streaming + the public 0.2 s probe asset
├── workspace/              configuration writes, brand profiles, assets, subtitle presets
├── usage/                  cost ledger: summary, daily series, raw records
├── system/                 health, readiness, queues, diagnostics (actionable findings)
├── queues/                 BullMQ queue registry and depth reporting
├── storage/                local + S3 drivers behind one interface
├── common/                 env (zod), guards, decorators, filters, interceptors, services
└── workers/                pipeline | render | publish | scheduler | recovery (+ base, clients)
```

## Commands

```bash
npm run dev:api        -w @clipforge/api   # tsx watch
npm run build          -w @clipforge/api
npm run worker:ai      -w @clipforge/api   # and render | publish | scheduler | recovery
```

## Rules

* Controllers parse input with a zod schema from `@clipforge/validation`, then call a service.
* Every query is scoped by `workspaceId` from the session — never from the request body.
* Operator-only routes carry `@Roles('OWNER', 'ADMIN')`; add them deliberately, not by accident.
* Long work never happens in a request. It becomes a durable job + an outbox event.

## API and storage behaviour

* `GET /api/accounts` returns at most 50 accounts by default (`pageSize` 1–100). Pass the returned
  `nextCursor` as `cursor` to fetch the next page; `null` means there are no more pages. Results are
  ordered by account ID, remain workspace-scoped, and retain the `accounts` and `integrations`
  fields. `eligiblePublishingPlatforms` covers the entire workspace, not just the current page.
  Automatic publishing selects the eligible account with the lowest ID for each platform.
* Direct-URL imports resolve and validate every redirect, pin connections to the checked public IP,
  preserve the original TLS hostname, and enforce a single deadline and byte limit. Compressed HTTP
  responses are rejected; the upstream must serve an uncompressed media file.
* Redis-backed rate limits fail closed on every budgeted request, including explicitly limited GETs.
  An outage returns `503 RATE_LIMIT_UNAVAILABLE` and `Retry-After: 5`; ordinary unbudgeted reads can
  still proceed. A dedicated connection does not queue or replay commands on reconnect, and readiness
  checks it separately. A command already received by Redis can still increment after its reply is lost.
  Do not bypass authentication or upload limits during a Redis incident.
* Local object writes and storage downloads stage next to the destination and atomically rename on
  success. S3 `PutObject` has object-level commit semantics. Failed writes leave an existing target
  intact; a forced process termination can leave an unreferenced `.tmp-<uuid>` staging file.
* Usage summaries and daily series are aggregated in PostgreSQL. `bytesStoredNow` remains an estimate
  based on the most recent storage ledger entry per source, not a check that each object still exists.
