import type { Song } from './scoring/types';
import { asset, entryFor, loadCatalog } from './catalog';
export type TimedWord = { text: string; start_s: number; end_s: number };
export type WordTiming = { v: 1; lines: { line: number; words: TimedWord[] }[] };

/** Validate the optional sidecar; reference.json and the score contract stay unchanged. */
export function parseWordTiming(value: unknown, song: Song): WordTiming {
  const data = value as WordTiming;
  if (data?.v !== 1 || !Array.isArray(data.lines) || data.lines.length !== song.lyrics.length) throw new Error('Некорректная разметка слов');
  let previousEnd = 0;
  data.lines.forEach((line, i) => {
    if (line?.line !== i || !Array.isArray(line.words) || !line.words.length || line.words.length > 100) throw new Error('Некорректная строка');
    for (const w of line.words) {
      if (typeof w.text !== 'string' || !w.text.trim() || !Number.isFinite(w.start_s) || !Number.isFinite(w.end_s) || w.start_s < previousEnd || w.end_s <= w.start_s || w.end_s > song.duration_s) throw new Error('Некорректное время слова');
      previousEnd = w.end_s;
    }
    if (Math.abs(line.words[0].start_s - song.lyrics[i].t) > .02 || line.words.map(w => w.text).join(' ') !== song.lyrics[i].text) throw new Error('Текст не совпадает с песней');
  });
  return data;
}

/** Half-open boundaries prevent double highlights; pauses keep the audio clock fixed. */
export function wordProgress(word: TimedWord, time: number) {
  return Math.max(0, Math.min(1, (time - word.start_s) / (word.end_s - word.start_s)));
}
export const isCurrentWord = (word: TimedWord, time: number) => time >= word.start_s && time < word.end_s;

/** Номер строки, которая звучит в момент time (−1 до первой строки); границы — по началу строки. */
export function lineAt(lyrics: { t: number }[], time: number): number {
  if (!(time >= 0)) return -1;
  let lo = 0, hi = lyrics.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lyrics[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Разметка слов из каталога (lyrics.words.json); без неё или при ошибке — null, слова показываются строками. */
export async function loadWordTiming(song: Song): Promise<WordTiming | null> {
  try {
    const file = entryFor(song.id, await loadCatalog())?.wordTiming;
    if (!file) return null;
    const response = await fetch(asset(song.id, file));
    return response.ok ? parseWordTiming(await response.json(), song) : null;
  } catch {
    return null;
  }
}
