# `services/video-processor` — rendering

FastAPI service wrapping FFmpeg. Stateless: bytes in, an MP4 and a measurement report out.

## Modules

| file | responsibility |
| --- | --- |
| `main.py` | `/health`, `/probe`, `/validate`, `/audio-analysis`, `/render` |
| `renderer.py` | filter graph, encode, output validation (probe + content scan) |
| `framing.py` | face-track / centre-crop / blur decisions, 9:16 composition |
| `subtitles.py` | ASS generation from real word timings, highlight events |
| `audio.py` | loudness (EBU R128), silence, clipping, volume measurement |

## Rules

* A render is only successful when the **content** is publishable, not merely decodable: no audio
  stream, silent audio (`< -55 dB`), A/V drift (`> 0.5 s`), mostly-black (`> 60%`) or mostly-frozen
  (`> 50%`) output is rejected with a classified error.
* Every number in the report is measured with ffprobe/ffmpeg — nothing is estimated.
* Source with no audio is refused before encoding (a clear error beats an FFmpeg exit code).
* `/render`, `/validate`, and `/audio-analysis` share a per-process pool:
  `VIDEO_PROCESSOR_MAX_CONCURRENT_WORK` (1–32, default 1) and `VIDEO_PROCESSOR_MAX_WAITING_WORK`
  (0–128, default 4). `/probe` has a separate pool (`VIDEO_PROCESSOR_MAX_CONCURRENT_PROBES`,
  default 2, and `VIDEO_PROCESSOR_MAX_WAITING_PROBES`, default 4). A full pool, or a waiter unable
  to start within five seconds, returns `503 SERVICE_CAPACITY_EXHAUSTED` and `Retry-After: 5`
  before work starts. Compatible workers retry just that request without consuming a job retry;
  upload validation instead reports a retryable inspection outage. `/live` and `/health` do not
  wait for either pool, though CPU/I/O pressure can still affect them.
* Limits multiply across Uvicorn processes and replicas and apply after body parsing/authentication;
  also bound incoming connections and body sizes at the proxy. Disconnected waiters are removed,
  but disconnecting does not cancel FFmpeg work already running. See `docs/OPERATIONS.md` for
  rollout order, cancellation and timeout limitations.
