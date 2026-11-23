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
* `/transcribe`, `/analyze`, and `/captions` share a dedicated per-process work limit:
  `AI_ENGINE_MAX_CONCURRENT_WORK` (1–32, default 1). Requests wait asynchronously instead of
  immediately consuming queue retries; disconnected waiters are dropped, though client deadlines can
  still expire. A model is loaded only once per configuration even if the limit is raised. `/live`
  and `/health` do not depend on the work pool.
* The limit multiplies across Uvicorn processes and replicas. Bound incoming requests and size for
  available CPU/memory; disconnecting does not cancel inference or analysis already running.
