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

Python `/live` runs on the event loop; `/health` is independent of expensive work. Per Python process:

| Pool / endpoints | Concurrent work (1–32) | Accepted waiters (0–128) |
| --- | --- | --- |
| AI `/transcribe`, `/analyze`, `/captions` | `AI_ENGINE_MAX_CONCURRENT_WORK` (default 1) | `AI_ENGINE_MAX_WAITING_WORK` (default 4) |
| Video `/render`, `/validate`, `/audio-analysis` | `VIDEO_PROCESSOR_MAX_CONCURRENT_WORK` (default 1) | `VIDEO_PROCESSOR_MAX_WAITING_WORK` (default 4) |
| Video `/probe` | `VIDEO_PROCESSOR_MAX_CONCURRENT_PROBES` (default 2) | `VIDEO_PROCESSOR_MAX_WAITING_PROBES` (default 4) |

A full pool, or an admitted waiter that cannot start within five seconds, returns HTTP 503 with
`detail.code=SERVICE_CAPACITY_EXHAUSTED`, `retryable=true`, and `Retry-After: 5`. This response is
issued **before work starts**. Pipeline and render workers retry only that service request with
jittered backoff while retaining the same BullMQ delivery and renewing the database lease; neither
capacity refusal nor waiting is a processing failure. This also avoids repeating an already-completed
analysis just because captions are busy. Workers check cancellation and lease ownership before each
resubmission, and log persistent capacity pressure. A worker slot remains occupied while waiting,
so sustained saturation can delay other jobs; monitor worker occupancy and queue depth and scale or
size the service appropriately.

Deploy the updated pipeline, render and scheduler workers **before** enabling the new Python service
versions: older pipeline/render workers treat a capacity 503 as a failed attempt, and older schedulers
can delete an old work directory without checking whether its job is active. Limits apply per process
and replica, not cluster-wide, and provide no global fairness. The admission cap is applied after HTTP
body parsing/authentication; configure proxy connection and body-size limits as well. Disconnecting or timing out a waiter removes
it, but running FFmpeg/Whisper work cannot be cancelled and keeps its slot until it finishes. An
accepted operation's timeout, a lost response, process crash, lease loss, or forced shutdown remains
ambiguous and can consume retries or repeat work not durably checkpointed; cancellation checks are not
atomic with a new service submission. `/probe` has a separate pool, though CPU/I/O contention can
still affect it.

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
staging files only after confirming the upload is no longer active or needed for retry. The scheduler
also retains processing-job directories for unfinished, configuration-paused, failed, or partially
completed jobs, including during capacity waits and possible manual retries. Completed or cancelled
jobs become eligible only after both the directory and terminal state are at least 48 hours old. These
retained directories can consume disk indefinitely; monitor and remove them only after confirming they
are no longer needed. The job-aware check does not cover clip-ID publishing scratch directories, nor
work that continues more than 48 hours after its job was cancelled. If PostgreSQL is unavailable, a
cleanup batch containing UUID directories is left in place rather than guessed safe.

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
