# `services/ai-engine` — transcription and analysis

FastAPI service. Receives a video path, returns scored clip candidates. Holds no database
connection; the API persists everything.

## Modules

| file | responsibility |
| --- | --- |
| `main.py` | HTTP surface: `/health`, `/probe`, `/analyse` |
| `pipeline.py` | stage sequence + report assembly |
| `media.py` | ffprobe/ffmpeg helpers, frame sampling, scene detection |
| `transcribe.py` | faster-whisper, word-level timestamps |
| `vision.py` | batched frame description (cost-controlled), returns token usage |
| `gemini.py` | Gemini client: structured output, bounded retries, usage extraction |
| `selection.py` | the rubric: validation, snapping to word boundaries, scoring, dedup, variants |
| `captions.py` | deterministic per-platform title/caption generation |
| `fixture_provider.py` | TEST ONLY — mechanical candidates so the pipeline can be tested without a key |
| `config.py` | settings; refuses to start without an explicit `AI_PROVIDER` |

## Rules

* The model proposes, this service validates. Model timestamps are never trusted verbatim.
* Calls are cost-bounded: frames are sampled and batched, and token usage is returned to the caller.
* `AI_PROVIDER=fixture` requires `TEST_MODE=1` and is refused in production.
* `/transcribe`, `/analyze`, and `/captions` share a per-process pool:
  `AI_ENGINE_MAX_CONCURRENT_WORK` (1–32, default 1) and `AI_ENGINE_MAX_WAITING_WORK`
  (0–128, default 4). A full pool, or a waiter unable to start within five seconds, returns
  `503 SERVICE_CAPACITY_EXHAUSTED` and `Retry-After: 5` **before** starting work. Compatible
  workers retry just that request while retaining their lease, without consuming a job retry.
  A model is loaded only once per configuration even if the limit is raised. `/live` and
  `/health` do not depend on the work pool.
* Limits multiply across Uvicorn processes and replicas and apply after body parsing/authentication;
  also bound incoming connections and body sizes at the proxy. Disconnected waiters are removed,
  but disconnecting does not cancel inference or analysis already running. See `docs/OPERATIONS.md`
  for rollout order, cancellation and timeout limitations.
