import { describe, expect, it } from "vitest";
import { parseWordTiming, type WordTiming } from "../src/lib/lyrics";
import type { Song } from "../src/lib/scoring/types";
import {
  clockText,
  currentLine,
  insertLine,
  linesFrom,
  payload,
  problems,
  removeLine,
  retext,
  setLineEnd,
  setLineStart,
  shiftAll,
  shiftLine,
  tokens,
  type EditLine,
} from "../src/lib/tracks/lyrics-edit";

const timing: WordTiming = {
  v: 1,
  lines: [
    { line: 0, words: [{ text: "раз", start_s: 1, end_s: 1.5 }, { text: "два", start_s: 1.5, end_s: 2 }, { text: "три", start_s: 2, end_s: 3 }] },
    { line: 1, words: [{ text: "четыре", start_s: 4, end_s: 5 }] },
    { line: 2, words: [{ text: "пять", start_s: 8, end_s: 9 }] },
  ],
};
const song = {
  duration_s: 12,
  lyrics: [{ t: 1, text: "раз два три" }, { t: 4, text: "четыре" }, { t: 8, text: "пять" }],
} as Pick<Song, "duration_s" | "lyrics">;

const fresh = () => linesFrom(song, timing);
const times = (line: EditLine) => line.words.map((w) => [w.text, w.start_s, w.end_s]);

/** Сохранённая правка должна читаться экраном пения так же, как файлы обработчика. */
function roundTrip(lines: EditLine[]) {
  const body = payload(lines);
  const words: WordTiming = { v: 1, lines: body.lines.map((l, i) => ({ line: i, words: l.words })) };
  const lyrics = body.lines.map((l) => ({ t: l.words[0].start_s, text: l.words.map((w) => w.text).join(" ") }));
  return parseWordTiming(words, { ...song, lyrics } as Song);
}

describe("редактор текста своего трека", () => {
  it("строки и слова берутся из разметки слов", () => {
    const lines = fresh();
    expect(lines.map((l) => [l.text, l.start, l.end])).toEqual([["раз два три", 1, 3], ["четыре", 4, 5], ["пять", 8, 9]]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
  });

  it("без разметки слова распределяются по строке до следующей", () => {
    const lines = linesFrom(song, null);
    expect(lines[0].start).toBe(1);
    expect(lines[0].end).toBeLessThanOrEqual(4);
    expect(lines[0].words.map((w) => w.text)).toEqual(["раз", "два", "три"]);
    expect(() => roundTrip(lines)).not.toThrow();
  });

  it("знаки препинания прилипают к слову, пробелы схлопываются", () => {
    expect(tokens("  Раз ,  два —  три!  ")).toEqual(["Раз,", "два—", "три!"]);
    expect(tokens("— привет")).toEqual(["—привет"]);
    expect(tokens(" … ")).toEqual([]);
  });

  it("правка текста: совпавшие слова сохраняют время, новые занимают место заменённых", () => {
    const [line] = fresh();
    const edited = retext(line, "Раз, ДВА четыре три");
    expect(edited.text).toBe("Раз, ДВА четыре три");
    // Между «два» и «три» нет паузы: новое слово делит время с соседом слева по слогам,
    // остальные слова сохраняют свои времена.
    expect(times(edited)).toEqual([["Раз,", 1, 1.5], ["ДВА", 1.5, 1.625], ["четыре", 1.625, 2], ["три", 2, 3]]);
    expect(() => roundTrip([edited, ...fresh().slice(1)])).not.toThrow();
  });

  it("замена слова получает его время, удаление слова убирает его время", () => {
    const [line] = fresh();
    expect(times(retext(line, "раз пять три"))).toEqual([["раз", 1, 1.5], ["пять", 1.5, 2], ["три", 2, 3]]);
    const shorter = retext(line, "два три");
    expect(times(shorter)).toEqual([["два", 1.5, 2], ["три", 2, 3]]);
    expect([shorter.start, shorter.end]).toEqual([1.5, 3]);
  });

  it("полностью новый текст распределяется по длине строки по слогам", () => {
    const [line] = fresh();
    const edited = retext(line, "совсем другие слова");
    expect(edited.words[0].start_s).toBe(1);
    expect(edited.words.at(-1)!.end_s).toBe(3);
    // Слоги 2 : 3 : 2.
    expect(times(edited)).toEqual([["совсем", 1, 1.571], ["другие", 1.571, 2.429], ["слова", 2.429, 3]]);
  });

  it("сдвиг строки не заходит на соседей и за границы отрывка", () => {
    const lines = fresh();
    const later = shiftLine(lines, 1, 0.1, 12)!;
    expect(times(later[1])).toEqual([["четыре", 4.1, 5.1]]);
    const capped = shiftLine(lines, 1, 10, 12)!;
    expect(capped[1].end).toBe(8);
    expect(shiftLine(capped, 1, 0.1, 12)).toBeNull();
    const first = shiftLine(lines, 0, -5, 12)!;
    expect(first[0].start).toBe(0);
    expect(times(first[0])).toEqual([["раз", 0, 0.5], ["два", 0.5, 1], ["три", 1, 2]]);
  });

  it("сдвиг всех строк сохраняет промежутки", () => {
    const moved = shiftAll(fresh(), -0.5, 12)!;
    expect(moved.map((l) => [l.start, l.end])).toEqual([[0.5, 2.5], [3.5, 4.5], [7.5, 8.5]]);
    expect(shiftAll(fresh(), -2, 12)![0].start).toBe(0);
    expect(shiftAll(fresh(), 5, 12)!.at(-1)!.end).toBe(12);
  });

  it("начало по нажатию переносит строку целиком, у соседа — сжимает", () => {
    const lines = fresh();
    const moved = setLineStart(lines, 1, 6, 12)!;
    expect([moved[1].start, moved[1].end]).toEqual([6, 7]);
    const squeezed = setLineStart(lines, 1, 7.5, 12)!;
    expect([squeezed[1].start, squeezed[1].end]).toEqual([7.5, 8]);
    expect(setLineStart(lines, 1, 2, 12)![1].start).toBe(3);
    expect(setLineStart(lines, 1, 8.5, 12)).toBeNull();
    expect(() => roundTrip(squeezed)).not.toThrow();
  });

  it("сжатая строка не оставляет слов короче 10 мс: слова заново делят время по слогам", () => {
    // Проверка рецензента: «я» длиной 40 мс при сжатии в 0,3 с стало бы 6 мс и сохранение отказало бы.
    const lines: EditLine[] = [
      { key: 901, text: "я люблю тебя", start: 1, end: 3, words: [{ text: "я", start_s: 1, end_s: 1.04 }, { text: "люблю", start_s: 1.04, end_s: 2 }, { text: "тебя", start_s: 2, end_s: 3 }] },
      { key: 902, text: "дальше", start: 5, end: 6, words: [{ text: "дальше", start_s: 5, end_s: 6 }] },
    ];
    const squeezed = setLineStart(lines, 0, 4.7, 12)!;
    expect([squeezed[0].start, squeezed[0].end]).toEqual([4.7, 5]);
    for (const w of squeezed[0].words) expect(w.end_s - w.start_s).toBeGreaterThanOrEqual(0.03);
    expect(times(squeezed[0])).toEqual([["я", 4.7, 4.76], ["люблю", 4.76, 4.88], ["тебя", 4.88, 5]]);
    expect(problems(squeezed, 12)).toBeNull();
    const ended = setLineEnd(lines, 0, 1.3, 12)!;
    for (const w of ended[0].words) expect(w.end_s - w.start_s).toBeGreaterThanOrEqual(0.03);
    expect(problems(ended, 12)).toBeNull();
  });

  // Короткие служебные слова по 10-29 мс обработчик выдаёт сам (MIN_WORD_S = 0,01).
  const shortWords = (): EditLine[] => [
    {
      key: 904,
      text: "и я люблю тебя",
      start: 10,
      end: 12,
      words: [
        { text: "и", start_s: 10, end_s: 10.02 },
        { text: "я", start_s: 10.02, end_s: 10.3 },
        { text: "люблю", start_s: 10.3, end_s: 11.5 },
        { text: "тебя", start_s: 11.5, end_s: 12 },
      ],
    },
  ];
  const lengthsMs = (line: EditLine) => line.words.map((w) => Math.round((w.end_s - w.start_s) * 1000));

  it("сдвиг строки без изменения длины не трогает времена слов, даже слово в 10-20 мс", () => {
    const [before] = shortWords();
    const [later] = shiftLine(shortWords(), 0, 0.1, 20)!;
    expect(lengthsMs(later)).toEqual(lengthsMs(before));
    expect(lengthsMs(later)).toEqual([20, 280, 1200, 500]);
    expect(later.words.map((w) => w.start_s)).toEqual([10.1, 10.12, 10.4, 11.6]);
    const [earlier] = shiftLine(shortWords(), 0, -0.1, 20)!;
    expect(lengthsMs(earlier)).toEqual([20, 280, 1200, 500]);
    const [all] = shiftAll(shortWords(), 0.1, 20)!;
    expect(lengthsMs(all)).toEqual([20, 280, 1200, 500]);
  });

  it("«Начало здесь» без сжатия переносит строку целиком, доли слов сохраняются", () => {
    const [moved] = setLineStart(shortWords(), 0, 13, 20)!;
    expect(moved.words.map((w) => [w.text, w.start_s, w.end_s])).toEqual([["и", 13, 13.02], ["я", 13.02, 13.3], ["люблю", 13.3, 14.5], ["тебя", 14.5, 15]]);
  });

  it("растяжение строки сохраняет доли слов; сжатие ниже 10 мс делит заново", () => {
    const [stretched] = setLineEnd(shortWords(), 0, 14, 20)!;
    expect(lengthsMs(stretched)).toEqual([40, 560, 2400, 1000]);
    const [mild] = setLineEnd(shortWords(), 0, 11.9, 20)!;
    expect(lengthsMs(mild)).toEqual([19, 266, 1140, 475]); // 0,95 от прежнего: «и» 19 мс, не меньше 10 мс
    // Вдвое короче: «и» ровно 10 мс — сервер принимает, доли сохраняются.
    const [half] = setLineEnd(shortWords(), 0, 11, 20)!;
    expect(lengthsMs(half)).toEqual([10, 140, 600, 250]);
    expect(problems([half], 20)).toBeNull();
    // Ещё короче «и» вышло бы 8 мс: слова делят время заново, каждое не короче 10 мс.
    const [hard] = setLineEnd(shortWords(), 0, 10.8, 20)!;
    expect(Math.min(...lengthsMs(hard))).toBeGreaterThanOrEqual(10);
    expect(lengthsMs(hard)).not.toEqual([8, 112, 480, 200]);
    expect(problems([hard], 20)).toBeNull();
  });

  it("слишком короткое слово — своя причина, а не «не по порядку»", () => {
    const lines: EditLine[] = [{ key: 903, text: "я", start: 1, end: 1.005, words: [{ text: "я", start_s: 1, end_s: 1.005 }] }];
    expect(problems(lines, 12)).toMatch(/Строка 1: слово «я» звучит меньше 10 мс/);
  });

  it("конец по нажатию растягивает или сжимает слова строки", () => {
    const lines = fresh();
    const stretched = setLineEnd(lines, 0, 3.5, 12)!;
    expect(times(stretched[0])).toEqual([["раз", 1, 1.625], ["два", 1.625, 2.25], ["три", 2.25, 3.5]]);
    expect(setLineEnd(lines, 0, 9, 12)![0].end).toBe(4);
    expect(setLineEnd(lines, 0, 1, 12)).toBeNull();
  });

  it("новая строка вставляется в паузу по времени и требует текста", () => {
    const { lines, index } = insertLine(fresh(), 6, 12)!;
    expect(index).toBe(2);
    expect([lines[2].start, lines[2].end, lines[2].words.length]).toEqual([6, 8, 0]);
    expect(problems(lines, 12)).toMatch(/Строка 3/);
    const filled = lines.map((l, i) => (i === 2 ? retext(l, "новая строка") : l));
    expect(problems(filled, 12)).toBeNull();
    expect(times(filled[2])[0][1]).toBe(6);
    // Внутри строки — после неё; без места — нельзя.
    expect(insertLine(fresh(), 4.5, 12)!.lines[2].start).toBe(5);
    expect(insertLine(fresh(), 8.9, 12)!.lines[3].start).toBe(9);
    const full = [{ ...fresh()[0], start: 0, end: 12, words: [{ text: "всё", start_s: 0, end_s: 12 }] }];
    expect(insertLine(full, 5, 12)).toBeNull();
  });

  it("удаление строки и пустой текст", () => {
    expect(removeLine(fresh(), 1).map((l) => l.text)).toEqual(["раз два три", "пять"]);
    const lines = fresh();
    lines[1] = retext(lines[1], "  ");
    expect(problems(lines, 12)).toMatch(/Строка 2.*пуст/);
    expect(problems([], 12)).toBeNull();
  });

  it("пределы как на сервере", () => {
    const many = Array.from({ length: 41 }, (_, i) => `с${i}`).join(" ");
    const [line] = fresh();
    expect(problems([retext({ ...line, end: 11 }, many)], 12)).toMatch(/40 слов/);
    expect(problems([retext(line, "а".repeat(41))], 12)).toMatch(/40 символов/);
  });

  it("тело запроса — только слова с временами в миллисекундах", () => {
    const [line] = fresh();
    const edited = setLineEnd([retext(line, "раз два три")], 0, 3.3337, 12)!;
    const body = payload(edited);
    expect(Object.keys(body)).toEqual(["lines"]);
    for (const w of body.lines[0].words) {
      expect(Object.keys(w)).toEqual(["text", "start_s", "end_s"]);
      expect(Math.round(w.start_s * 1000) / 1000).toBe(w.start_s);
      expect(Math.round(w.end_s * 1000) / 1000).toBe(w.end_s);
    }
  });

  it("текущая строка и формат времени", () => {
    const lines = fresh();
    expect([0.5, 1, 2.99, 3.5, 4.2, 9].map((t) => currentLine(lines, t))).toEqual([-1, 0, 0, -1, 1, -1]);
    expect(clockText(72.35)).toBe("1:12,3");
    expect(clockText(5)).toBe("0:05,0");
  });
});
