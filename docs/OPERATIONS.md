# Operations

## Deployment topology

`docker-compose.prod.yml` runs: `postgres`, `redis`, `api`, five worker roles, `ai-engine`,
`video-processor`, `web`, `caddy`, `backup`. Only Caddy publishes ports (80/443); every application
port stays on the internal network.

```bash
# production
cp .env.example .env                 # fill every required value; compose refuses to start otherwise
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
```

The `example.com` origins in `.env.example` are placeholders: replace the app, CORS, API, media,
and OAuth callback origins with your own deployment values before starting. `render.yaml` and
`apps/web/api-target.json` describe the existing deployment, not reusable examples. For a hosted
fork, set `API_INTERNAL_URL` at build time or update `api-target.json`; otherwise the web build can
still proxy requests to the existing deployment's API.

`api` starts with `RUN_MIGRATIONS=1`, so the entrypoint applies pending migrations once before the
process starts; workers wait on the API.

Caddy terminates TLS with automatic ACME for `CLIPFORGE_DOMAIN` and proxies `/api` and `/media` to
the API and everything else to Next.js, keeping cookies first-party. `infrastructure/deployment/nginx.conf`
is the equivalent configuration if you standardise on nginx.

## Health

* `GET /api/system/health` — dependency checks (PostgreSQL, Redis, storage, AI engine, video
  processor).
* `GET /api/system/readiness` — can this instance serve work (configuration + integrations).
* `GET /api/system/overview` — the payload behind the System administration page: components,
  worker heartbeats, queue depths, counts, health events, storage driver, Graph version, uptime.
* `bash infrastructure/scripts/healthcheck.sh` — operator smoke test over all three services.

Python `/live` runs on the event loop; `/health` is independent of expensive work. The AI service
limits `/transcribe`, `/analyze`, and `/captions` to `AI_ENGINE_MAX_CONCURRENT_WORK` (default 1),
while the video service limits `/render`, `/validate`, and `/audio-analysis` to
`VIDEO_PROCESSOR_MAX_CONCURRENT_WORK` (default 1) and `/probe` to a separate
`VIDEO_PROCESSOR_MAX_CONCURRENT_PROBES` pool (default 2). Limits are per process, so multiply them by
number of Uvicorn processes and replicas. A request waits asynchronously for capacity rather than
immediately consuming BullMQ retries; a disconnected waiter is removed, but FFmpeg or Whisper work
already running is not cancelled and continues to occupy its slot. A request that exceeds its client
deadline can still consume a retry. Pending requests themselves are not capped by these limits: bound
request concurrency at the worker/proxy and provision CPU/memory even for a single job. `/probe` has
its own work pool, so it does not wait for a render slot; CPU and I/O contention can still affect it.

An upload whose inspection returns `503 VIDEO_PROCESSOR_UNAVAILABLE` is not rejected as invalid media.
The upload page can retry validation without uploading the parts again while it remains open. This
in-memory retry does not survive a reload, and an ambiguous proxy/network timeout is not automatically
replayed. Direct-URL imports must be started again after an inspection outage; a failed attempt can
remain `INITIATED` in the source list.

When Redis is unavailable, ordinary unbudgeted reads still work but rate-limited routes (including
sensitive GETs and all mutations) fail closed with `503 RATE_LIMIT_UNAVAILABLE` and a five-second
`Retry-After`. A dedicated connection is checked by readiness and will not queue or replay security
commands on reconnect; a command already received by Redis may still count if its reply is lost.
Check Redis connectivity and `/api/system/health`; do not disable the limiter.

Local storage stages writes as adjacent `.tmp-<uuid>` files. A crash can leave orphaned files; only
remove stale temporary files after confirming no writer is active, never the final object itself.
Incomplete local uploads, including those retained for inspection retries, live under
`WORK_DIR/uploads` and are not automatically expired; monitor that directory and remove abandoned
staging files only after confirming the upload is no longer active or needed for retry.

## Backups

`infrastructure/scripts/backup-postgres.sh` writes a custom-format `pg_dump` (compressed, no
ownership), a SHA-256 sidecar, verifies it with `pg_restore --list`, and prunes files older than
`BACKUP_RETENTION_DAYS`. In compose the `backup` service runs it at startup and every
`BACKUP_INTERVAL_SECONDS` (default 86400).

Restore is `infrastructure/scripts/restore-postgres.sh <dump> --yes`: it verifies the checksum and
runs `pg_restore --clean --if-exists`.

Both were executed against this environment's database: a dump was produced, restored into a
scratch database, and the restored schema contained all 30 tables with the expected row counts
(`docs/VERIFICATION.md`, run log 2026-11-09).

Object storage is *not* covered by pg_dump: back up the bucket (or the `storage-data` volume) with
the same cadence. The database stores keys, not bytes.

## Retention

The scheduler worker prunes per workspace at the configured `retention.source_days` and
`retention.asset_days`. The asset window must be longer than the window in which Meta may fetch a
Reel; shortening it below that breaks pending Instagram publishes (the API will report the failed
fetch rather than pretend it succeeded). Workspace and expiring-account maintenance scans use bounded
pages. Overlapping runs of each maintenance task are skipped within one scheduler process, not across
replicas; a slow scan can therefore delay its next run.

## Runbook

| Symptom | Check | Action |
| --- | --- | --- |
| Jobs stuck in `QUEUED` | `GET /api/system/queue-status`, worker status | Start the missing worker role; confirm Redis reachable |
| Job stuck in a stage with no progress | System administration → worker heartbeat age | If the heartbeat is stale, the recovery sweep will requeue it within 30 s |
| `RETRYING` loop | `GET /api/jobs/:id` events + `errorCode` | A `PERMANENT` platform error will not clear by retrying; fix the account/privacy/metadata |
| `NEEDS_CONFIGURATION` | Settings page → missing keys | Fill the listed keys; retry the job |
| Publish `401`/`AUTH` | Connected accounts → token health | Re-connect the account; refresh tokens are used automatically until they are revoked |
| Instagram `ERROR` container | publish job detail | Usually the media URL is not publicly reachable or the file is outside the allowed spec |
| Disk filling up | storage root usage | Lower retention windows or move to object storage |

## Upgrades

1. Back up the database.
2. Pull, `docker compose -f docker-compose.prod.yml build`.
3. `docker compose -f docker-compose.prod.yml up -d` — the entrypoint applies migrations.
4. Verify with `bash infrastructure/scripts/healthcheck.sh` and the System administration page.

Rollback is a code revert plus, when a migration is destructive, a restore from the pre-upgrade
dump.
