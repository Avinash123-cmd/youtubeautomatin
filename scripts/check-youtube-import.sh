#!/usr/bin/env bash
# Preflight for YouTube URL import: the tools and flags the pipeline worker needs to fetch a video.
#
# Usage: bash scripts/check-youtube-import.sh
# Exit codes: 0 = import can run, 1 = import is disabled by configuration, 2 = a tool is missing.
#
# Nothing here downloads a video or touches the network: it answers "would the worker be able to
# start a download on this host, and with which limits?".
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
failures=0

value_of() { # key -> value (empty when unset, blank or absent)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^["'\'']//; s/["'\'']$//' | tr -d '\r'
}
value_or() { # key, default
  local value
  value="$(value_of "$1")"
  printf '%s' "${value:-$2}"
}
ok() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

echo "YouTube URL import preflight"
echo "(env file: ${ENV_FILE})"
echo

# ---- 1. is the feature switched on ---------------------------------------------------------------
enabled="$(value_or YOUTUBE_IMPORT_ENABLED true)"
if [ "$enabled" = "true" ] || [ "$enabled" = "1" ]; then
  ok "YOUTUBE_IMPORT_ENABLED=true — POST /api/sources/youtube is accepted"
else
  bad "YOUTUBE_IMPORT_ENABLED=$enabled — the API answers 503 CONFIGURATION_REQUIRED; pasted URLs cannot be processed"
fi

# ---- 2. the downloader ---------------------------------------------------------------------------
binary="$(value_or YTDLP_PATH yt-dlp)"
if command -v "$binary" >/dev/null 2>&1; then
  version="$("$binary" --version 2>/dev/null | head -1)"
  ok "yt-dlp $version ($(command -v "$binary"))"
elif [ -x "$binary" ]; then
  version="$("$binary" --version 2>/dev/null | head -1)"
  ok "yt-dlp ${version:-unknown version} ($binary)"
else
  bad "yt-dlp not found (YTDLP_PATH=$binary) — install it: pip install --upgrade yt-dlp, or set YTDLP_PATH"
fi

# ---- 3. ffmpeg, required to merge the separate video and audio streams ---------------------------
ffmpeg_location="$(value_or YOUTUBE_YTDLP_FFMPEG_LOCATION '')"
ffmpeg_bin="ffmpeg"
if [ -n "$ffmpeg_location" ]; then
  ffmpeg_bin="$ffmpeg_location/ffmpeg"
fi
if command -v "$ffmpeg_bin" >/dev/null 2>&1; then
  ok "ffmpeg ($(command -v "$ffmpeg_bin")) — quality above 720p needs it to mux DASH streams"
else
  skip "ffmpeg not found — yt-dlp falls back to a single progressive stream (usually 720p max)"
fi

# ---- 4. optional session cookies, only needed when YouTube asks for a sign-in ---------------------
cookies="$(value_or YOUTUBE_COOKIES_FILE '')"
if [ -z "$cookies" ]; then
  skip "YOUTUBE_COOKIES_FILE is empty — fine for public videos; set it if downloads fail with 'bot check'"
elif [ -r "$cookies" ] && [ -s "$cookies" ]; then
  ok "cookie file readable ($cookies)"
else
  bad "YOUTUBE_COOKIES_FILE=$cookies is not a readable non-empty file — every download will fail"
fi

# ---- 5. the limits that decide whether a video is importable at all -----------------------------
echo
echo "Limits applied to every import:"
printf '  %-34s %s\n' "YOUTUBE_IMPORT_MAX_HEIGHT" "$(value_or YOUTUBE_IMPORT_MAX_HEIGHT 1080) (p, never upscaled)"
printf '  %-34s %s\n' "YOUTUBE_IMPORT_MAX_FILESIZE_MB" "$(value_or YOUTUBE_IMPORT_MAX_FILESIZE_MB 2048) (MiB, enforced by yt-dlp and re-checked on disk)"
printf '  %-34s %s\n' "YOUTUBE_IMPORT_TIMEOUT_SECONDS" "$(value_or YOUTUBE_IMPORT_TIMEOUT_SECONDS 1800) (s, then the whole process group is killed)"
printf '  %-34s %s\n' "YOUTUBE_PROXY" "$(value_or YOUTUBE_PROXY '—')"
echo
echo "Workspace limits (saved settings, not env) cap duration and size again at ingest time."
echo

if [ "$failures" -eq 0 ]; then
  echo "RESULT: import is ready on this host."
  exit 0
fi
if [ "$enabled" != "true" ] && [ "$enabled" != "1" ]; then
  echo "RESULT: import is switched off by configuration ($failures check(s) failed)."
  exit 1
fi
echo "RESULT: $failures check(s) failed — see docs/YOUTUBE-IMPORT.md."
exit 2
