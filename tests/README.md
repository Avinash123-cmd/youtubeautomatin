# `tests/`

Four kinds, deliberately separated by what they need to run.

| suite | command | needs | covers |
| --- | --- | --- | --- |
| `unit/` | `npm run test:unit` | nothing | state machine, validation, crypto, platform connectors, cost maths, diagnostics |
| `integration/` | `npm run test:integration` | Postgres + Redis | outbox transactionality, repository behaviour, concurrency |
| `python/` | `npm run test:python` | ffmpeg | render validation parser + real verdicts (silent/black/frozen/wrong-size) |
| `e2e/` | `npm run test:e2e` | full stack running | upload → transcript → selection → render → download |
| `e2e/scenarios.py` | `.venv/bin/python tests/e2e/scenarios.py` | full stack running | 19 scenarios (health, CSRF, limits, pipeline, quality, usage, restart) |
| `e2e/authorization_matrix.py` | `.venv/bin/python tests/e2e/authorization_matrix.py` | full stack running | 27 anonymous / role / cross-tenant checks |

`e2e/harness.py` holds the shared CSRF-aware client and the throwaway-tenant helpers — use it rather
than writing another HTTP client.

Rules: a scenario asserts with evidence (status, id, measured value) in its output line; a test that
cannot fail is not a test.

## Current explicit prerequisites

Full-workflow E2E has no baked-in account credentials or machine-specific fixture path. Configure
`CLIPFORGE_EMAIL`, `CLIPFORGE_PASSWORD` and `CLIPFORGE_TEST_VIDEO` (or pass the video path as argument).
Use a disposable environment and a speech-bearing source for Whisper. Unit test secrets must be
non-production; the test commands in the current readiness report provide an example. Python service
HTTP tests require the pinned FastAPI/Pydantic dependencies and httpx; FFmpeg verdict tests additionally
require real ffmpeg/ffprobe executables. Missing media tools are reported as skips, never render passes.
