// Правка распознанного текста своего трека: строки, слова и их времена. Чистые функции
// без DOM: экран /tracks/<id>/lyrics хранит массив строк и заменяет его результатом.
// Пределы совпадают с проверкой сервера (crates/api/src/tracks.rs, `check_lyrics`).
import type { TimedWord, WordTiming } from "#lib/lyrics.ts";
import type { Song } from "#lib/scoring/types.ts";

export const MAX_LINES = 80;
export const MAX_LINE_WORDS = 40;
export const MAX_WORDS = 600;
export const MAX_WORD_CHARS = 40;
/** Шаг кнопок «−0,1 с» и «+0,1 с». */
export const NUDGE_S = 0.1;
/** Нажатие во время звучания запаздывает примерно на время реакции; на паузе — точно. */
export const TAP_REACTION_S = 0.15;
/** Меньше этого на слово строку не сжимаем: слово успевает прозвучать. */
const MIN_SPREAD_S = 0.08;
/** Сервер принимает слово не короче 10 мс. */
const MIN_WORD_S = 0.01;
/** Если при сжатии строки слово стало бы короче (а было не короче), слова строки заново делят время по слогам. */
const SQUEEZE_FLOOR_S = 0.03;
/** Новая строка: до 2 секунд, но не короче 0,3 с. */
const NEW_LINE_S = 2;
const NEW_LINE_MIN_S = 0.3;

export interface EditLine {
  key: number;
  /** Текст строки в поле ввода; слова пересчитываются при подтверждении (`retext`). */
  text: string;
  start: number;
  end: number;
  words: TimedWord[];
}

let keys = 0;
const nextKey = () => ++keys;
const ms = (x: number) => Math.round(x * 1000) / 1000;
const HAS_LETTER = /[\p{L}\p{N}]/u;
const VOWELS = /[аеёиоуыэюяaeiouy]/giu;

/** Сравнение слов без регистра, «ё» и знаков препинания. */
const norm = (text: string) => text.toLocaleLowerCase("ru").replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, "");
/** Вес слова для распределения времени — число слогов (не меньше одного). */
const weight = (text: string) => Math.max(1, text.match(VOWELS)?.length ?? 0);
const minSpan = (words: number) => Math.max(1, words) * MIN_SPREAD_S;

/** Слова строки: пробелы схлопываются, знак без букв прилипает к соседнему слову. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of text.split(/\s+/u)) {
    if (!raw) continue;
    if (!HAS_LETTER.test(raw)) {
      if (out.length) out[out.length - 1] += raw;
      else pending += raw;
      continue;
    }
    out.push(pending + raw);
    pending = "";
  }
  return out;
}

const shortest = (words: TimedWord[]) => Math.min(...words.map((w) => w.end_s - w.start_s));

/** Слова подряд на отрезке [start, end] пропорционально слогам; если так слово вышло бы короче 10 мс — поровну. */
function spread(texts: string[], start: number, end: number): TimedWord[] {
  const lay = (w: (t: string) => number) => {
    const total = texts.reduce((sum, t) => sum + w(t), 0);
    let acc = 0;
    return texts.map((text) => {
      const a = start + ((end - start) * acc) / total;
      acc += w(text);
      const b = start + ((end - start) * acc) / total;
      return { text, start_s: ms(a), end_s: ms(b) };
    });
  };
  const bySyllables = lay(weight);
  return shortest(bySyllables) >= MIN_WORD_S - 1e-9 ? bySyllables : lay(() => 1);
}

function withWords(line: EditLine, words: TimedWord[]): EditLine {
  const text = words.map((w) => w.text).join(" ");
  return words.length ? { ...line, text, words, start: words[0].start_s, end: words[words.length - 1].end_s } : { ...line, words };
}

/** Строки для правки из файлов трека; без разметки слов — по началам строк. */
export function linesFrom(song: Pick<Song, "duration_s" | "lyrics">, timing: WordTiming | null): EditLine[] {
  if (timing) {
    return timing.lines.map((l) => withWords({ key: nextKey(), text: "", start: 0, end: 0, words: [] }, l.words.map((w) => ({ ...w }))));
  }
  return song.lyrics.map((l, i) => {
    const limit = i + 1 < song.lyrics.length ? song.lyrics[i + 1].t : song.duration_s;
    const texts = tokens(l.text);
    const end = Math.min(limit, l.t + Math.max(1.5, texts.length * 0.6));
    const line = { key: nextKey(), text: l.text, start: l.t, end, words: [] as TimedWord[] };
    return texts.length ? withWords(line, spread(texts, l.t, end)) : line;
  });
}

/** Наибольшая общая подпоследовательность по нормализованным словам: пары (новое, старое). */
function anchors(next: string[], old: TimedWord[]): (TimedWord | null)[] {
  const a = next.map(norm);
  const b = old.map((w) => norm(w.text));
  const best = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      best[i][j] = a[i] === b[j] ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
  const out: (TimedWord | null)[] = new Array(a.length).fill(null);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) out[i++] = old[j++];
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * Новый текст строки. Слова, совпавшие со старыми, сохраняют свои времена; новые слова
 * делят промежуток между соседними сохранёнными словами по слогам. Если промежутка не
 * хватает, ближайшие сохранённые слова тоже перераспределяются (сначала слева).
 */
export function retext(line: EditLine, text: string): EditLine {
  const next = tokens(text);
  if (!next.length) return { ...line, text: text.trim(), words: [] };
  const pinned = line.words.length ? anchors(next, line.words) : next.map(() => null);
  for (;;) {
    let fixed = true;
    for (let a = 0; a < next.length && fixed; a++) {
      if (pinned[a]) continue;
      let b = a;
      while (b < next.length && !pinned[b]) b++;
      const left = a > 0 ? pinned[a - 1]!.end_s : line.start;
      const right = b < next.length ? pinned[b]!.start_s : line.end;
      if (right - left < minSpan(b - a) && (a > 0 || b < next.length)) {
        if (a > 0) pinned[a - 1] = null;
        else pinned[b] = null;
        fixed = false;
      }
      a = b;
    }
    if (fixed) break;
  }
  const words: TimedWord[] = [];
  for (let a = 0; a < next.length; ) {
    const old = pinned[a];
    if (old) {
      words.push({ text: next[a], start_s: old.start_s, end_s: old.end_s });
      a++;
      continue;
    }
    let b = a;
    while (b < next.length && !pinned[b]) b++;
    const left = a > 0 ? words[a - 1].end_s : line.start;
    const right = b < next.length ? pinned[b]!.start_s : line.end;
    words.push(...spread(next.slice(a, b), left, right));
    a = b;
  }
  return withWords(line, words);
}

const prevEnd = (lines: EditLine[], i: number) => (i > 0 ? lines[i - 1].end : 0);
const nextStart = (lines: EditLine[], i: number, duration: number) => (i + 1 < lines.length ? lines[i + 1].start : duration);

/** Ставит строку на [start, end], растягивая или сжимая её слова; null — если нельзя. */
function place(lines: EditLine[], i: number, start: number, end: number, duration: number): EditLine[] | null {
  const line = lines[i];
  start = ms(start);
  end = ms(end);
  if (start < prevEnd(lines, i) - 1e-9 || end > nextStart(lines, i, duration) + 1e-9 || end - start < minSpan(line.words.length) - 1e-9) return null;
  const span = line.end - line.start;
  let words: TimedWord[];
  if (Math.abs(end - start - span) < 0.0005) {
    // Длина та же (сдвиг, «Начало здесь» без сжатия): слова просто переезжают, их времена не меняются.
    const d = start - line.start;
    words = line.words.map((w) => ({ ...w, start_s: ms(w.start_s + d), end_s: ms(w.end_s + d) }));
  } else {
    const at = (t: number) => ms(span > 0 ? start + ((t - line.start) * (end - start)) / span : start);
    words = line.words.map((w) => ({ ...w, start_s: at(w.start_s), end_s: at(w.end_s) }));
    // Делим заново по слогам, только если строку сжали и слово стало бы почти без времени:
    // было не короче 30 мс, а стало короче, или вышло меньше 10 мс, которые принимает сервер.
    const squeezed = end - start < span && words.some((w, k) => {
      const now = w.end_s - w.start_s;
      const was = line.words[k].end_s - line.words[k].start_s;
      return now < MIN_WORD_S - 1e-9 || (was >= SQUEEZE_FLOOR_S - 1e-9 && now < SQUEEZE_FLOOR_S - 1e-9);
    });
    if (squeezed) words = spread(words.map((w) => w.text), start, end);
  }
  const moved = words.length ? withWords(line, words) : { ...line, start, end };
  return lines.map((l, k) => (k === i ? moved : l));
}

/** Сдвиг строки на `delta` секунд, но не на соседние строки и не за края отрывка. */
export function shiftLine(lines: EditLine[], i: number, delta: number, duration: number): EditLine[] | null {
  const line = lines[i];
  const d = Math.min(Math.max(delta, prevEnd(lines, i) - line.start), nextStart(lines, i, duration) - line.end);
  if (Math.abs(d) < 0.0005) return null;
  return place(lines, i, line.start + d, line.end + d, duration);
}

/** Сдвиг всех строк вместе, промежутки между ними сохраняются. */
export function shiftAll(lines: EditLine[], delta: number, duration: number): EditLine[] | null {
  if (!lines.length) return null;
  const d = ms(Math.min(Math.max(delta, -lines[0].start), duration - lines[lines.length - 1].end));
  if (Math.abs(d) < 0.0005) return null;
  return lines.map((l) =>
    l.words.length
      ? withWords(l, l.words.map((w) => ({ ...w, start_s: ms(w.start_s + d), end_s: ms(w.end_s + d) })))
      : { ...l, start: ms(l.start + d), end: ms(l.end + d) },
  );
}

/** «Начало здесь»: строка переносится целиком; если до следующей строки мало места, сжимается. */
export function setLineStart(lines: EditLine[], i: number, t: number, duration: number): EditLine[] | null {
  const line = lines[i];
  const start = Math.max(t, prevEnd(lines, i));
  const end = Math.min(start + (line.end - line.start), nextStart(lines, i, duration));
  return place(lines, i, start, end, duration);
}

/** «Конец здесь»: начало остаётся, слова растягиваются или сжимаются до нового конца. */
export function setLineEnd(lines: EditLine[], i: number, t: number, duration: number): EditLine[] | null {
  return place(lines, i, lines[i].start, Math.min(t, nextStart(lines, i, duration)), duration);
}

/** Пустая строка в паузе около `t` (внутри строки — сразу после неё); ввод текста — следом. */
export function insertLine(lines: EditLine[], t: number, duration: number): { lines: EditLine[]; index: number } | null {
  const index = lines.filter((l) => l.start <= t).length;
  const start = ms(Math.max(0, index > 0 ? Math.max(t, lines[index - 1].end) : t));
  const end = ms(Math.min(start + NEW_LINE_S, nextStart(lines, index - 1, duration)));
  if (end - start < NEW_LINE_MIN_S) return null;
  const line: EditLine = { key: nextKey(), text: "", start, end, words: [] };
  return { lines: [...lines.slice(0, index), line, ...lines.slice(index)], index };
}

export const removeLine = (lines: EditLine[], i: number) => lines.filter((_, k) => k !== i);

/** Первая причина, по которой сервер не примет правку, или null. */
export function problems(lines: EditLine[], duration: number): string | null {
  if (lines.length > MAX_LINES) return `Слишком много строк: не больше ${MAX_LINES}.`;
  if (lines.reduce((n, l) => n + l.words.length, 0) > MAX_WORDS) return `Слишком много слов: не больше ${MAX_WORDS}.`;
  let previous = 0;
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    if (!line.words.length) return `Строка ${n} пустая: впиши слова или удали строку.`;
    if (line.words.length > MAX_LINE_WORDS) return `Строка ${n}: больше ${MAX_LINE_WORDS} слов, раздели её.`;
    for (const w of line.words) {
      if ([...w.text].length > MAX_WORD_CHARS) return `Строка ${n}: слово длиннее ${MAX_WORD_CHARS} символов.`;
      if (w.start_s < previous - 1e-9 || w.end_s > duration + 1e-9) return `Строка ${n}: время слов не по порядку. Сдвинь строку.`;
      if (w.end_s - w.start_s < MIN_WORD_S - 1e-9)
        return `Строка ${n}: слово «${w.text}» звучит меньше 10 мс. Растяни строку кнопкой «Конец здесь» или поправь текст.`;
      previous = w.end_s;
    }
  }
  return null;
}

/** Тело PUT /api/tracks/<id>/lyrics. */
export function payload(lines: EditLine[]) {
  return { lines: lines.map((l) => ({ words: l.words.map((w) => ({ text: w.text, start_s: ms(w.start_s), end_s: ms(w.end_s) })) })) };
}

/** Строка, которая звучит в момент `t` (конец не включается), или −1. */
export const currentLine = (lines: EditLine[], t: number) => lines.findIndex((l) => t >= l.start && t < l.end);

/** «1:12,3» — минуты, секунды и десятые. */
export function clockText(t: number) {
  const tenths = Math.floor(Math.max(0, t) * 10 + 1e-6);
  const s = Math.floor(tenths / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")},${tenths % 10}`;
}
