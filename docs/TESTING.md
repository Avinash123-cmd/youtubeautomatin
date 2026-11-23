# Testing

Three layers, all runnable locally. Integration tests create and delete real records: point them
only at a disposable test database, never at production. No test fabricates a result.

## Unit — `npm run test:unit`

Vitest, no external services (`tests/vitest.config.ts`). Coverage includes:

* `tests/unit/state-machine.test.ts` — every state has a transition list, the happy path walks in
  order, `ASSET_STORAGE → COMPLETED` is allowed (regression: manual publishing used to dead-end),
  terminal states absorb, `RETRYING` is reachable from every started state but not from `CREATED`,
  and unknown transitions are rejected.
* `tests/unit/validation.test.ts` — rights declaration required, non-HTTPS import rejected, upload
  mime/size sanity, YouTube visibility and terms acceptance required to enable publishing, brand
  colour format, subtitle style completeness.
* `tests/unit/platform-connectors.test.ts` — 429 → `RATE_LIMIT` with `retry-after`, 5xx →
  retryable, 401/403 → `AUTH` (not auto-retried), 4xx → `PERMANENT`, platform code/subcode
  surfaced, backoff growth and jitter window, YouTube consent URL contract, unsupported Graph
  version rejected instead of defaulted.
* `tests/unit/crypto.test.ts` — AES-256-GCM round-trip, fresh IV per encryption, tamper detection,
  HMAC determinism and purpose separation, refusal when the secret is unset.

## Integration — `npm run test:integration`

Vitest against **real PostgreSQL** (`tests/vitest.integration.config.ts`). Throwaway workspaces
are created and deleted by the database tests. Coverage includes:

* full job lifecycle with stage bookkeeping (no stage left `RUNNING`),
* illegal transition rejected and row untouched,
* `FAILED → RETRYING → resume`,
* lease acquisition exclusivity, released-lease ≠ abandonment, stale heartbeat = abandonment,
* control-state rows ignored when computing the resume point,
* outbox row written in the same transaction as the job, claimed exactly once with a visibility
  timeout, failure recorded without losing the event,
* audit log captures actor/IP/metadata,
* configuration resolution reports every missing key instead of defaulting, and workspace values
  win over global rows.

Requires `DATABASE_URL` (read from `.env`). Not mocked: this is the same Prisma client the workers
use. The account pagination and usage aggregation checks create and delete two temporary workspaces;
run them only against a disposable database. An additional Redis disconnect test starts its own Unix
socket server when `REDIS_TEST_BINARY` points to a `redis-server` executable; it skips otherwise:

```bash
REDIS_TEST_BINARY="$(command -v redis-server)" npx vitest run --config tests/vitest.integration.config.ts tests/integration/redis-resilience.test.ts
```

`tests/integration/service-capacity.test.ts` additionally requires both the disposable PostgreSQL
`DATABASE_URL` and `REDIS_TEST_BINARY`. It uses real BullMQ, leases, and recovery with stubbed Python
HTTP, storage and configuration. It checks that caption/render capacity refusals keep one delivery
active, renew its lease, protect its old work directory, avoid repeat analysis and retries, and stop
resubmission on cancellation:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/clipforge_test" REDIS_TEST_BINARY="$(command -v redis-server)" \
  npx vitest run --config tests/vitest.integration.config.ts tests/integration/service-capacity.test.ts
```

Python limiter tests cover bounded admission, timeout, disconnect/cancellation and separate probe
capacity, including real Uvicorn TCP connections (`python -m unittest discover -s tests/python -v`).
These tests do not exercise real providers, FFmpeg saturation or a production load balancer.

## End-to-end — `.venv/bin/python tests/e2e/full_workflow.py <video>`

A strict HTTP harness against a running stack (API, AI engine, video processor, all five workers).
It performs: CSRF fetch → login → explicit configuration write → chunked upload → FFprobe
validation → job creation → stage polling → clip selection → render → clip download and probe of the
downloaded file → metadata preview → dashboard/audit/worker assertions. It fails loudly on any
non-2xx, on a job that does not reach a terminal state, or on numbers that do not match the API's own
dashboard summary.

Run:

Telegram notifications have all three layers: `tests/unit/telegram-notifications.test.ts` (retry
schedule, redaction, rendering — no I/O), `tests/integration/notifications.test.ts` (real PostgreSQL,
fake Bot API over HTTP), and `tests/e2e/telegram_notifications.py` (real API process and workers,
36 checks including restart recovery and duplicate suppression on a live event).

```bash
.venv/bin/python tests/e2e/full_workflow.py /home/user/testdata/light-source.mp4
```

Use a small source (1280×720, ~30 s). A 2560×1440 source makes FFmpeg pegging all cores look like
an API stall — that is CPU saturation, not a defect.

## End-to-end scenarios — `.venv/bin/python tests/e2e/scenarios.py [video]`

Nineteen scenarios (45 checks) that each answer one operator question — health contract, CSRF,
login rate limiting, session revocation, chunked-upload integrity, upload limits, SSRF, the
configuration gate, the full pipeline, render quality, HTTP Range, duplicate submissions,
cancellation, retry rules, per-platform metadata, publishing eligibility, usage costs, the
authorization matrix and durability across a worker restart. Every scenario runs inside a guard, so
one failure is reported and the rest still run; the exit code is `0` only when all of them pass.

Telegram notifications have all three layers: `tests/unit/telegram-notifications.test.ts` (retry
schedule, redaction, rendering — no I/O), `tests/integration/notifications.test.ts` (real PostgreSQL,
fake Bot API over HTTP), and `tests/e2e/telegram_notifications.py` (real API process and workers,
36 checks including restart recovery and duplicate suppression on a live event).

```bash
.venv/bin/python tests/e2e/scenarios.py /home/user/testdata/light-source.mp4
```

## Account security — `bash tests/e2e/run_auth_security.sh`

Drives two-step sign-in against a **real SMTP server** (`tests/e2e/smtp_sink.py`, port 1025): the runner
restarts the API with `SMTP_HOST=127.0.0.1` so the API delivers codes through nodemailer over TCP and the
suite reads them out of the delivered message. 46 checks: policy refusal for a channel that cannot
deliver, password-only login unchanged, step-up challenge with no session cookie, wrong code rejected
with `attemptsRemaining` decrementing, correct code opening the session, replay rejected, resend
cooldown, sign-in history contents, hashed-at-rest codes, session revocation, password reset revoking
every session, recovery-code issue/redeem/reuse-refused, and a Telegram link to an unknown chat failing
loudly.

The admin account's `otpMode` is restored to `OFF` in a `finally` block, so a failed run cannot lock the
next suite out.

## Adversarial probes — `.venv/bin/python tests/e2e/logic_probes.py`

The suites above prove the product works on the happy path. These probes try to break the logic:
inverted ranges, garbage timestamps, a model that inflates its own quality score, duplicate
windows, unknown framing modes, a missing video, an empty word list, a rubric that must sum to 1.0.
They import the real modules (`services/ai-engine/app/selection.py`,
`services/video-processor/app/{subtitles,framing}.py`) — nothing is mocked — and assert the *reason*
for each rejection, so a "returns nothing" regression fails instead of passing quietly.

## Verification helpers

* `infrastructure/scripts/verify-pipeline.py` — drives the AI engine and the video processor
  directly and re-probes every rendered file (resolution, codecs, duration).
* `infrastructure/scripts/healthcheck.sh` — dependency smoke test.

## Preconditions for the integration suite

`npm run test:integration` talks to the same PostgreSQL/Redis the running stack uses, and one case
asserts it is the *only* consumer that claims a freshly written outbox row. **Stop the workers before
running it**, otherwise a live worker can legitimately claim the row first and the assertion fails for
environmental reasons:

```bash
pkill -f "dist/workers/"      # or stop them however you launched them
npm run test:integration
```

Cases include ranged reads honouring byte offsets, order-independent multipart parts, and `attempt`
counting retries rather than lease acquisitions. See `IMPLEMENTATION_STATUS.md` for historical audit
results; run the suites above for current counts.

## Blocked-by-credentials tests

Anything that needs a third party is marked **BLOCKED — awaiting credentials** rather than skipped
silently: Gemini structured analysis (runs use the fixture provider with `TEST_MODE=1`), YouTube
upload, Instagram container publish, S3/R2 storage, and the ACME/TLS deployment path. Each has code
coverage at the unit level (request building, error classification, configuration guards) and an
explicit live test that cannot pass without real credentials.
