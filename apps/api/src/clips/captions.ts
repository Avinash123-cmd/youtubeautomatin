/**
 * Caption (subtitle) generation for a rendered clip.
 *
 * The renderer burns word-highlighted captions into the video; this module produces the same speech
 * as a portable SRT/VTT file so a clip can be published with platform captions, edited elsewhere, or
 * reviewed without watching the video. Pure functions: the API only supplies word timings.
 */

export interface CaptionWord {
  word: string;
  start: number;
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface CueOptions {
  /** Characters per cue. 42 is the classic two-line broadcast limit. */
  maxChars?: number;
  maxDuration?: number;
  maxWords?: number;
}

const SENTENCE_END = /[.!?]["')\]]?$/;

/**
 * Groups words into short cues.
 *
 * Two constraints matter for readability: a cue must not be too long (two lines at most) and it must
 * not stay on screen after the speaker has moved on. Sentence ends always break a cue, which keeps
 * subtitle text aligned with what is being said.
 */
export function buildCues(words: CaptionWord[], options: CueOptions = {}): CaptionCue[] {
  const maxChars = options.maxChars ?? 42;
  const maxDuration = options.maxDuration ?? 3.5;
  const maxWords = options.maxWords ?? 10;

  const cues: CaptionCue[] = [];
  let current: CaptionWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((word) => word.word).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      cues.push({ start: current[0].start, end: current[current.length - 1].end, text });
    }
    current = [];
  };

  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start) continue;
    const candidateText = [...current, word].map((entry) => entry.word).join(' ');
    const candidateDuration = current.length === 0 ? 0 : word.end - current[0].start;
    if (current.length > 0 && (candidateText.length > maxChars || current.length >= maxWords || candidateDuration > maxDuration)) {
      flush();
    }
    current.push(word);
    if (SENTENCE_END.test(word.word) && current.length >= 3) flush();
  }
  flush();
  return cues;
}

/** Shifts absolute source timings to clip-relative timings and clamps to the clip window. */
export function wordsForWindow(words: CaptionWord[], startSeconds: number, endSeconds: number): CaptionWord[] {
  return words
    .filter((word) => word.end > startSeconds && word.start < endSeconds)
    .map((word) => ({
      word: word.word,
      start: Math.max(0, Number((word.start - startSeconds).toFixed(3))),
      end: Math.max(0, Number((Math.min(word.end, endSeconds) - startSeconds).toFixed(3))),
    }))
    .filter((word) => word.end > word.start);
}

function timestamp(seconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${timestamp(cue.start, ',')} --> ${timestamp(cue.end, ',')}\n${cue.text}\n`)
    .join('\n')
    .trimEnd()
    .concat('\n');
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues
    .map((cue) => `${timestamp(cue.start, '.')} --> ${timestamp(cue.end, '.')}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`.trimEnd().concat('\n');
}

/** Plain transcript text for a clip window — used by the UI as "copy caption text". */
export function plainText(cues: CaptionCue[]): string {
  return cues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim();
}
