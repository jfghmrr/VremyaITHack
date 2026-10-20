import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRIDGE_S, displayCurve, isSynthesized, referencePath, stageSpan, type LinePoint } from "../src/lib/ui/reference-line";
import { shortShare, type Ref as Song } from "./short-parts";

const root = new URL("../static/songs/", import.meta.url);
const catalog = (JSON.parse(readFileSync(new URL("index.json", root), "utf8")) as { id: string }[]).map((s) => s.id);
type Ref = { hop_ms: number; duration_s: number; f0_midi: (number | null)[] };
const load = (id: string): Ref => JSON.parse(readFileSync(new URL(`${id}/reference.json`, root), "utf8"));

// Как в PianoRoll: окно 9 с, «сейчас» на четверти ширины, линия толщиной 10 px с круглыми концами.
const SPAN = 9;
const CAP = 5;
const HOP = 0.01;

/** Canvas не обводит отрезок нулевой длины (проверено в Chromium и WebKit): такой части на экране нет. */
const stroked = (part: LinePoint[]) => part.some((p, k) => k > 0 && (p.x !== part[k - 1].x || p.m !== part[k - 1].m));

/** Доля столбцов окна с голосом в эталоне, на которых нарисована линия (концы — полукруги радиусом CAP). */
function coverage(f0: (number | null)[], now: number, width: number) {
  const left = now - SPAN * 0.25;
  const painted = new Array<boolean>(width).fill(false);
  for (const part of referencePath(f0, HOP, left, SPAN, width, CAP)) {
    if (!stroked(part)) continue;
    const xs = part.map((p) => p.x);
    for (let c = Math.max(0, Math.floor(Math.min(...xs) - CAP)); c < Math.min(width, Math.ceil(Math.max(...xs) + CAP)); c++) painted[c] = true;
  }
  let voiced = 0;
  let hit = 0;
  for (let c = 0; c < width; c++) {
    const i = Math.floor((left + ((c + 0.5) / width) * SPAN) / HOP);
    if (i < 0 || i >= f0.length || f0[i] === null) continue;
    voiced++;
    if (painted[c]) hit++;
  }
  return { voiced, hit };
}

describe("линия эталона на сцене пения", () => {
  it("на снимке владельца (As I Am, 3 с, график 336 px на iPhone) линия видна, а не отдельными точками", () => {
    const { voiced, hit } = coverage(load("jw-as-i-am").f0_midi, 3.05, 336);
    expect(voiced).toBeGreaterThan(100);
    expect(hit / voiced).toBeGreaterThanOrEqual(0.95);
  });

  // Ширины графика: телефон в портрете (320–375 px), телефон в ландшафте и ноутбук.
  for (const width of [320, 336, 375, 760]) {
    it(`каждая песня каталога: линия покрывает голос эталона по всей песне при ширине ${width} px`, () => {
      const low: string[] = [];
      for (const id of catalog) {
        const song = load(id);
        let voiced = 0;
        let hit = 0;
        for (let now = 0; now < song.duration_s; now += 0.5) {
          const c = coverage(song.f0_midi, now, width);
          voiced += c.voiced;
          hit += c.hit;
        }
        if (hit / voiced < 0.95) low.push(`${id}: ${((100 * hit) / voiced).toFixed(0)}%`);
      }
      expect(low).toEqual([]);
    });
  }

  it("ни одна часть линии не схлопывается в отрезок нулевой длины", () => {
    for (const id of catalog) {
      const f0 = load(id).f0_midi;
      for (const width of [320, 760]) {
        const zero = referencePath(f0, HOP, 0.75, SPAN, width, CAP).filter((part) => !stroked(part));
        expect(zero, `${id} ${width} px`).toEqual([]);
      }
    }
  });

  it("ноты синтезированного эталона остаются отдельными ровными полосами с отступом на круглый конец", () => {
    const f0 = [...Array(50).fill(60), ...Array(50).fill(62), ...Array(10).fill(null), ...Array(30).fill(62), ...Array(10).fill(null)];
    // 100 px в секунду: кадр 10 мс — ровно пиксель. Те же полосы рисовал прежний PianoRoll.
    const parts = referencePath(f0, HOP, 0, 1.5, 150, CAP);
    const px = (x: number) => Math.round(x * 1000) / 1000;
    expect(parts.map((p) => [px(p[0].x), px(p.at(-1)!.x), p[0].m])).toEqual([
      [5, 45, 60],
      [55, 95, 62],
      [115, 135, 62],
    ]);
    for (const part of parts) expect(new Set(part.map((p) => p.m)).size).toBe(1);
  });

  it("короткий озвученный кусок виден, хотя короче толщины линии", () => {
    const f0 = [...Array(20).fill(null), 60, 60.1, 60, ...Array(20).fill(null)];
    const parts = referencePath(f0, HOP, 0, SPAN, 336, CAP);
    expect(parts).toHaveLength(1);
    expect(stroked(parts[0])).toBe(true);
  });

  it("плавный подъезд к ноте — одна линия, повторяющая высоту; концы — высота кадра под концом", () => {
    const f0 = Array.from({ length: 30 }, (_, k) => 58 + k * 0.1);
    const parts = referencePath(f0, HOP, 0, SPAN, 336, CAP);
    expect(parts).toHaveLength(1);
    const ms = parts[0].map((p) => p.m);
    // Конец отступает на 5 px (при 336 px на 9 с это 13 кадров): там голос уже на 59,3.
    const frame = (x: number) => Math.floor(((x / 336) * SPAN) / HOP);
    expect(ms[0]).toBeCloseTo(f0[frame(parts[0][0].x)]);
    expect(ms.at(-1)).toBeCloseTo(f0[Math.min(29, frame(parts[0].at(-1)!.x))]);
    expect(ms[0]).toBeGreaterThan(58);
    expect(ms.at(-1)).toBeLessThan(60.95);
    expect(ms.every((m, k) => k === 0 || m >= ms[k - 1])).toBe(true);
  });

  it("не больше одной точки ломаной на пиксель", () => {
    for (const id of ["oi-to-ne-vecher", "amazing-grace-usaf"]) {
      const f0 = load(id).f0_midi;
      for (const part of referencePath(f0, HOP, 2, SPAN, 336, CAP)) {
        const width = part.at(-1)!.x - part[0].x;
        expect(part.length, id).toBeLessThanOrEqual(Math.ceil(width) + 2);
        for (let k = 2; k < part.length - 1; k++) expect(part[k].x - part[k - 1].x).toBeGreaterThanOrEqual(1 - 1e-9);
      }
    }
  });

  it("быстрый спад голоса в конце фразы — одна линия, а не цепочка точек", () => {
    // cn-earth, 10,5 с: 60,8 → 57,3 за 90 мс, до 0,6 полутона между соседними кадрами.
    const f0 = [61, 61, 61, 60.9, 60.8, 60.6, 60.4, 60.2, 59.9, 59.5, 59.0, 58.4, 58.0, 57.5, 57.3];
    expect(referencePath(f0, HOP, 0, SPAN, 760, CAP)).toHaveLength(1);
  });

  it("пауза или скачок между кадрами на полутон рвут линию, сдвиг на 0,4 полутона — нет", () => {
    const parts = (f0: (number | null)[]) => referencePath(f0, HOP, 0, SPAN, 760, CAP).length;
    expect(parts([...Array(20).fill(60), null, ...Array(20).fill(60)])).toBe(2);
    expect(parts([...Array(20).fill(60), ...Array(20).fill(61)])).toBe(2);
    expect(parts([...Array(20).fill(60), ...Array(20).fill(60.4)])).toBe(1);
  });
});

describe("линия эталона на телефоне: окно, сглаживание и мостики (только отображение)", () => {
  const songOf = (id: string) => load(id) as unknown as Song;
  const choppy = ["va-angel", "cn-wonder", "va-starry-vortex", "cn-last-ring", "oi-to-ne-vecher", "jw-as-i-am"];

  it("окно графика: около 55 px на секунду, от 6 до 9 секунд", () => {
    expect(stageSpan(336)).toBeCloseTo(336 / 55);
    expect(stageSpan(200)).toBe(6);
    expect(stageSpan(496)).toBe(9);
    expect(stageSpan(1200)).toBe(9);
  });

  it("рваные эталоны на телефоне: доля голоса в «точках» короче 14 px падает как минимум вдвое и не выше 30 %", () => {
    for (const id of choppy) {
      for (const width of [336, 319]) {
        const before = shortShare(songOf(id), width, "before");
        const after = shortShare(songOf(id), width, "after");
        expect(after, `${id} ${width} px: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%`).toBeLessThanOrEqual(Math.min(0.3, before / 2));
      }
    }
  });

  it("ни одна песня каталога не становится рванее", () => {
    for (const id of catalog) {
      const song = songOf(id);
      expect(shortShare(song, 336, "after"), id).toBeLessThanOrEqual(shortShare(song, 336, "before") + 1e-9);
    }
  });

  it("синтезированный эталон (целые ноты) не меняется: те же полосы, паузы не соединяются", () => {
    const f0 = [...Array(50).fill(60), ...Array(50).fill(62), ...Array(5).fill(null), ...Array(30).fill(62), ...Array(10).fill(null)];
    expect(isSynthesized(f0)).toBe(true);
    expect(displayCurve(f0, HOP, [{ start_s: 0, end_s: 2 }])).toEqual(f0);
    expect(referencePath(displayCurve(f0, HOP), HOP, 0, 1.5, 150, CAP)).toEqual(referencePath(f0, HOP, 0, 1.5, 150, CAP));
  });

  const live = (n: number, m = 60) => Array.from({ length: n }, (_, k) => m + 0.05 * Math.sin(k));
  const phrase = [{ start_s: 0, end_s: 10 }];

  it("короткая пауза внутри фразы при близкой высоте перекрывается плавным переходом", () => {
    const f0 = [...live(20, 60), ...Array(10).fill(null), ...live(20, 61.5)];
    const d = displayCurve(f0, HOP, phrase);
    expect(d.slice(20, 30).every((m) => m !== null)).toBe(true);
    for (let k = 20; k < 30; k++) expect(d[k]!).toBeGreaterThan(59.9), expect(d[k]!).toBeLessThan(61.6);
    expect(referencePath(d, HOP, 0, 6, 336, CAP)).toHaveLength(1);
    // Исходная кривая (её считает ядро) не меняется.
    expect(f0.slice(20, 30).every((m) => m === null)).toBe(true);
  });

  it("не соединяются: длинная пауза, пауза на границе фраз, большой скачок высоты, края песни", () => {
    const gap = (frames: number) => [...live(20), ...Array(frames).fill(null), ...live(20)];
    // Длиннее BRIDGE_S — это пауза между словами или фразами.
    const long = gap(Math.round(BRIDGE_S / HOP) + 1);
    expect(displayCurve(long, HOP, phrase).filter((m) => m === null)).toHaveLength(Math.round(BRIDGE_S / HOP) + 1);
    // Граница фраз внутри паузы.
    const atBoundary = gap(8);
    expect(displayCurve(atBoundary, HOP, [{ start_s: 0, end_s: 0.24 }, { start_s: 0.24, end_s: 1 }]).filter((m) => m === null)).toHaveLength(8);
    // Скачок высоты больше двух полутонов.
    const leap = [...live(20, 60), ...Array(8).fill(null), ...live(20, 62.5)];
    expect(displayCurve(leap, HOP, phrase).filter((m) => m === null)).toHaveLength(8);
    // Тишина до первой и после последней ноты остаётся тишиной.
    const edges = [...Array(5).fill(null), ...live(20), ...Array(5).fill(null)];
    const d = displayCurve(edges, HOP, phrase);
    expect(d.slice(0, 5).every((m) => m === null) && d.slice(25).every((m) => m === null)).toBe(true);
  });

  it("сглаживание убирает дрожание, но не сдвигает ноту и не размывает переход между нотами", () => {
    const wobble = Array.from({ length: 40 }, (_, k) => 60 + (k % 2 ? 0.4 : -0.4));
    const d = displayCurve(wobble, HOP, phrase);
    const swing = (xs: (number | null)[]) => Math.max(...xs.slice(1).map((m, k) => Math.abs(m! - xs[k]!)));
    expect(swing(d)).toBeLessThan(swing(wobble) / 2);
    for (const m of d) expect(Math.abs(m! - 60)).toBeLessThanOrEqual(0.4);
    // Ступень в полтора полутона: граница остаётся на месте, по обе стороны — исходные ноты.
    const step = [...Array(20).fill(60.1), ...Array(20).fill(61.6)];
    const s = displayCurve(step, HOP, phrase);
    expect(s.slice(0, 20).every((m) => Math.abs(m! - 60.1) < 1e-9)).toBe(true);
    expect(s.slice(20).every((m) => Math.abs(m! - 61.6) < 1e-9)).toBe(true);
  });

  it("на графике кадры каталога остаются у исходной высоты: медиана ближе 0,15, 99 % ближе 0,85, все ближе 1,5 полутона", () => {
    for (const id of catalog) {
      const song = songOf(id);
      const d = displayCurve(song.f0_midi, song.hop_ms / 1000, song.phrases);
      const errors = song.f0_midi.flatMap((m, k) => (m === null ? [] : [Math.abs(d[k]! - m)])).sort((a, b) => a - b);
      // Одиночные выбросы распознавания сглаживаются сильнее, но не дальше полутора полутонов.
      expect(errors.at(-1)!, id).toBeLessThanOrEqual(1.5);
      expect(errors[Math.floor(errors.length * 0.99)], id).toBeLessThanOrEqual(0.85);
      expect(errors[errors.length >> 1], id).toBeLessThanOrEqual(0.15);
    }
  });
});
