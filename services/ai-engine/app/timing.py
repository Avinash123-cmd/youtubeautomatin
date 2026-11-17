"""Validate ASR timestamps before they can drive subtitle or trim commands.

No retiming or invented words: invalid source/provider data fails explicitly.
Small ASR rounding differences are tolerated, never repaired silently.
"""
from __future__ import annotations

import math


class TranscriptTimingError(ValueError):
    pass


def validate_transcript(transcript: dict, duration_seconds: float) -> dict:
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise TranscriptTimingError("Source duration must be finite and positive")
    segments = transcript.get("segments")
    if not isinstance(segments, list):
        raise TranscriptTimingError("Transcript segments must be a list")
    previous_start = -1.0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise TranscriptTimingError(f"Segment {index} must contain source text")
        start, end = _range(segment, f"Segment {index}", duration_seconds)
        if start < previous_start:
            raise TranscriptTimingError("Transcript segments are not chronologically ordered")
        previous_start = start
        words = segment.get("words", [])
        if not isinstance(words, list):
            raise TranscriptTimingError(f"Segment {index} words must be a list")
        last_word_start = start - 0.05
        for word in words:
            if not isinstance(word, dict) or not isinstance(word.get("word"), str):
                raise TranscriptTimingError(f"Segment {index} contains an invalid word")
            ws, we = _range(word, f"Segment {index} word", duration_seconds)
            if ws < start - 0.05 or we > end + 0.05 or ws < last_word_start:
                raise TranscriptTimingError(f"Segment {index} word timing is outside its segment or unordered")
            last_word_start = ws
    return transcript


def _range(item: dict, label: str, duration: float) -> tuple[float, float]:
    values = (item.get("start"), item.get("end"))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise TranscriptTimingError(f"{label} timestamps must be finite numbers")
    start, end = values
    if start < 0 or end <= start or end > duration + 0.05:
        raise TranscriptTimingError(f"{label} timestamps are outside the media duration or inverted")
    return float(start), float(end)
