# YouTube URL import

Pasting a YouTube link is a first-class way to create a project. It is implemented with **yt-dlp**
(a real download, not a mocked one), runs inside the pipeline worker, and stores the result exactly
like an upload. This document explains the flow, the safety rails, the configuration and the
operator responsibilities.

## The flow, end to end

```
POST /api/sources/youtube/inspect     →  oEmbed preview (title, channel, thumbnail); no media is fetched
POST /api/sources/youtube             →  SourceVideo(kind=YOUTUBE, status=INITIATED) + audited rights declaration
POST /api/jobs                        →  ProcessingJob(QUEUED) referencing that source
      └─ pipeline worker, stage PROBING
           1. yt-dlp downloads to <WORK_DIR>/<job>/youtube-<source>.<ext>
           2. ffprobe (video-processor) validates duration/resolution/codecs over HTTP
           3. workspace limits are enforced (max duration, max file size)
           4. the file is uploaded to object storage under ws/<workspace>/sources/<id>/original.mp4
           5. SourceVideo → VALIDATED (+ sourceMetadata, ingestedAt)
      └─ TRANSCRIBING → AI_ANALYSIS → CLIP_SELECTION → RENDERING → publishing (if requested)
```

Two facts follow from this design:

* **The HTTP request never downloads anything.** A 90-minute video would otherwise hold a request
  open for minutes, and a browser refresh would orphan the work. The worker owns the download, the
  lease, the retries and the storage write.
* **Progress is real.** The worker writes the download percentage into `progressDetail` at most
  every 3 seconds (or every 5 percentage points), so the job page shows what is actually happening.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOUTUBE_IMPORT_ENABLED` | `true` | Master switch. When `false`, `POST /api/sources/youtube` returns `428 CONFIGURATION_REQUIRED` and the dashboard explains why. |
| `YTDLP_PATH` | `yt-dlp` | Absolute path or PATH name of the binary. |
| `YOUTUBE_IMPORT_MAX_HEIGHT` | `1080` | Highest rendition downloaded. The clip renderer crops to 9:16, so 1080 is the useful ceiling. |
| `YOUTUBE_IMPORT_TIMEOUT_SECONDS` | `1800` | Hard kill for one download. A timeout is retryable. |
| `YOUTUBE_IMPORT_MAX_FILESIZE_MB` | `2048` | Passed to yt-dlp and enforced again on the resulting file. |
| `YOUTUBE_COOKIES_FILE` | — | Optional Netscape cookie file for age-restricted videos or the "confirm you're not a bot" wall. Mount it read-only; never commit it. |
| `YOUTUBE_PROXY` | — | Optional outbound proxy (`http://user:pass@host:port`). |
| `YOUTUBE_YTDLP_FFMPEG_LOCATION` | — | Directory containing ffmpeg/ffprobe for stream merging. |

Install the tool on the API/worker host:

```bash
# Debian/Ubuntu
sudo apt-get install -y python3 ffmpeg
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod 0755 /usr/local/bin/yt-dlp

# or, in a Python environment
python3 -m pip install --upgrade yt-dlp
```

The API container already installs both (`infrastructure/docker/api.Dockerfile`, build arg
`YTDLP_VERSION`, default `latest`). Because YouTube changes its player frequently, a pinned yt-dlp
older than a few weeks will start failing its own checks: update it as part of routine maintenance
(`docker build --build-arg YTDLP_VERSION=<tag>`).

`GET /api/sources/youtube/status` reports `{ enabled, tool: { available, version, reason } }`, and
the create page renders that state before the user pastes anything.

## Safety rails (each one is enforced in code, not by convention)

| Concern | Control |
| --- | --- |
| Arbitrary URL / SSRF | Only `youtube.com`, `www.youtube.com`, `m.youtube.com` and `youtu.be` with a valid 11-character id are accepted. The downloader receives a **canonical** `https://www.youtube.com/watch?v=<id>` URL; query parameters (including `list=`) are discarded. |
| Playlist expansion | `--no-playlist` is always passed; a playlist URL is rejected outright. |
| Argument injection | `spawn()` without a shell, and the URL is the last argument after `--`, so it can never be parsed as a flag. |
| Disk exhaustion | `--max-filesize` at the tool level, a size check on the resulting file, and the workspace `maxFileSizeBytes` limit from configuration. |
| Unbounded runtime | Hard timeout with `SIGKILL`, classified as retryable. |
| Silent failure | yt-dlp stderr is classified (private, unavailable, rate-limited, bot-check, too large, binary missing) and mapped to `FAILED`, `RETRYING` or `NEEDS_CONFIGURATION` with an actionable message. |
| Unlicensed reuse | Every source requires an explicit rights declaration (≥20 characters), stored with user id, IP, user agent and timestamp in `AuditLog`; the job also requires it. |
| Duplicate work | One active job per source (row lock + re-check inside the transaction). |

Missing tooling is **not** a job failure: the worker transitions the job to `NEEDS_CONFIGURATION`,
keeps the retry budget intact and tells the operator exactly what to install.

## What about transcripts?

The transcript always comes from the audio of the downloaded media (Faster-Whisper, word-level
timestamps). YouTube's own captions are not scraped or trusted, so the burned-in captions match the
audio that is actually in the clip.

## Rights and platform terms

Downloading a video does not grant the right to republish it. The product requires the user to
declare a right to the content, and the operator of the deployment is responsible for how the
feature is used. If you only want users to process their own footage, set
`YOUTUBE_IMPORT_ENABLED=false`: the upload and direct-URL paths keep working.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `428 CONFIGURATION_REQUIRED … yt-dlp` | binary missing from the API host | install yt-dlp or fix `YTDLP_PATH`, then retry the job from the UI |
| Job moves to `NEEDS_CONFIGURATION` | same, discovered at ingest time | fix the host, press **Retry** |
| `YOUTUBE_IMPORT_FORBIDDEN` | YouTube asked for a signed-in session | provide `YOUTUBE_COOKIES_FILE` or upload the original file |
| `YOUTUBE_SOURCE_TOO_LARGE` | file above the configured cap | raise `YOUTUBE_IMPORT_MAX_FILESIZE_MB` or the workspace limit |
| `YOUTUBE_SOURCE_UNAVAILABLE` | private, removed or region-blocked | nothing to retry; choose another source |
| Download stalls at 0% | outbound network blocked | check egress/proxy settings |

## What has been run, and what has not

Honest verification record for this feature. Anything not listed as executed was **not** executed.

| Check | Command / method | Result |
| --- | --- | --- |
| TypeScript (API) | `npx tsc -p apps/api/tsconfig.json --noEmit` | clean |
| TypeScript (dashboard) | `cd apps/web && npx tsc --noEmit` | clean |
| Lint | `cd apps/web && npx eslint .` | clean |
| Unit suite | `npx vitest run --config tests/vitest.config.ts` | 70 files, 556 passed, 3 skipped |
| Dashboard build | `cd apps/web && npx next build` | succeeded, all routes compiled |
| Structure gate | `bash scripts/check-structure.sh` | 82 checks passed, 0 failed |
| YAML (compose + Render) | parsed with PyYAML | valid |

Not executable in the authoring environment, therefore unproven there: a real `yt-dlp` download
(no `yt-dlp`, no `ffmpeg`), an ffprobe validation of downloaded media, an actual YouTube upload and
an actual Instagram Reel publish. Those paths are exercised the first time you run the stack with
credentials; the failure branches they can hit are the ones in the troubleshooting table above.
