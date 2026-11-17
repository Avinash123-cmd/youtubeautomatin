import { describe, expect, it } from 'vitest';
import {
  buildCues,
  plainText,
  toSrt,
  toVtt,
  wordsForWindow,
  type CaptionWord,
} from '../../apps/api/src/clips/captions';

/** Helper: evenly spaced words, 0.35 s each, starting at `start`. */
function words(text: string, start = 0, step = 0.35): CaptionWord[] {
  return text.split(' ').map((word, index) => ({
    word,
    start: Number((start + index * step).toFixed(3)),
    end: Number((start + (index + 1) * step).toFixed(3)),
  }));
}

describe('caption cue building', () => {
  it('keeps cues short and never splits a word', () => {
    const cues = buildCues(words('one two three four five six seven eight nine ten eleven twelve'), { maxWords: 4 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.text.split(' ').length).toBeLessThanOrEqual(4);
    expect(cues.map((cue) => cue.text).join(' ')).toContain('eleven twelve');
  });

  it('breaks at sentence ends once the cue is substantial', () => {
    const cues = buildCues(words('We start here. Then we continue with a much longer sentence that keeps going', 0, 0.3));
    expect(cues[0].text.endsWith('here.')).toBe(true);
  });

  it('respects the character budget, except for a single word that cannot be split', () => {
    const cues = buildCues(words('supercalifragilisticexpialidocious words follow here and there'), { maxChars: 20 });
    for (const cue of cues) {
      const singleWord = cue.text.split(' ').length === 1;
      if (!singleWord) expect(cue.text.length).toBeLessThanOrEqual(20);
    }
    // The long word still appears exactly once and is not dropped.
    expect(cues.filter((cue) => cue.text.includes('supercalifragilisticexpialidocious'))).toHaveLength(1);
  });

  it('drops words with unusable timings', () => {
    const cues = buildCues([
      { word: 'bad', start: Number.NaN, end: 1 },
      { word: 'inverted', start: 5, end: 4 },
      { word: 'good', start: 6, end: 7 },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('good');
  });

  it('produces monotonically increasing cue windows', () => {
    const cues = buildCues(words('a sentence that runs long enough to wrap across several cues in total', 10, 0.4));
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index].start).toBeGreaterThanOrEqual(cues[index - 1].start);
      expect(cues[index].end).toBeGreaterThanOrEqual(cues[index].start);
    }
  });
});

describe('clip-relative windowing', () => {
  const source = words('zero one two three four five six', 100, 1);

  it('shifts absolute timings so the clip starts at zero', () => {
    const window = wordsForWindow(source, 102, 105);
    expect(window[0]).toMatchObject({ word: 'two', start: 0 });
    expect(window.every((word) => word.start >= 0)).toBe(true);
  });

  it('clamps the last word to the clip end', () => {
    const window = wordsForWindow([{ word: 'tail', start: 103.5, end: 108 }], 103, 105);
    expect(window[0].end).toBeLessThanOrEqual(2);
  });

  it('excludes words outside the window', () => {
    expect(wordsForWindow(source, 0, 1)).toHaveLength(0);
  });

  it('never returns a zero-length word', () => {
    const window = wordsForWindow([{ word: 'edge', start: 104.9, end: 105 }], 105, 110);
    expect(window).toHaveLength(0);
  });
});

describe('serialisation', () => {
  const cues = [
    { start: 0, end: 1.5, text: 'First line' },
    { start: 61.25, end: 63.999, text: 'Second line' },
  ];

  it('writes SRT with comma millisecond separators and 1-based indices', () => {
    expect(toSrt(cues)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nFirst line\n\n2\n00:01:01,250 --> 00:01:03,999\nSecond line\n',
    );
  });

  it('writes WebVTT with a header and dot separators', () => {
    expect(toVtt(cues)).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nFirst line\n\n00:01:01.250 --> 00:01:03.999\nSecond line\n',
    );
  });

  it('joins plain text for copying', () => {
    expect(plainText(cues)).toBe('First line Second line');
  });

  it('pads every timestamp component to a fixed width', () => {
    expect(toSrt([{ start: 3725.004, end: 3726, text: 'late' }])).toContain('01:02:05,004 --> 01:02:06,000');
  });
});
