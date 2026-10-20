// Сдвиг тональности линии голоса на сцене (stage-key.ts): только картинка. Уже нарисованные точки
// не двигаются, сдвиг устойчив к фразам, фальши и срывам на октаву, меняется с гистерезисом.
import { describe, expect, it } from "vitest";
import { createStageKey, fixStageKey, keyEstimate, medianInPlace, seedStageKey, STAGE_KEY, stageKeyAt, stageOffsets, updateStageKey, type StageKey } from "../src/lib/ui/stage-key";
import { createVoicePath, voicePath } from "../src/lib/ui/voice-line";

type F = { t: number; midi: number | null };
const HOP = 0.01;

/** Эталон: фразы по 3 с из нот по 0,4 с, между фразами пауза 0,5 с. */
function melody(seconds: number): (number | null)[] {
  const notes = [60, 62, 64, 65, 67, 65, 64, 62];
  return Array.from({ length: Math.round(seconds / HOP) }, (_, i) => {
    const t = i * HOP;
    const inPhrase = t % 3.5;
    if (inPhrase >= 3) return null;
    return notes[Math.floor(inPhrase / 0.4) % notes.length];
  });
}

/** Детерминированный шум ±amp. */
function noise(i: number, amp: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

/** Певец: эталон + shift(t) (null — молчит) + вибрато и шум. */
function sing(f0: (number | null)[], shift: (t: number) => number | null, amp = 0.2): F[] {
  return f0.map((r, i) => {
    const t = Math.round(i * HOP * 1000) / 1000;
    const s = shift(t);
    return { t, midi: r === null || s === null ? null : r + s + 0.15 * Math.sin(2 * Math.PI * 5.5 * t) + noise(i, amp) };
  });
}

/** Подать кадры порциями, как приходят от детектора (один массив растёт). */
function feed(key: StageKey, all: F[], f0: (number | null)[], chunk = 6, each?: (live: F[]) => void) {
  const live: F[] = [];
  for (let i = 0; i < all.length; i += chunk) {
    for (let k = i; k < Math.min(all.length, i + chunk); k++) live.push(all[k]);
    updateStageKey(key, live, f0, HOP);
    each?.(live);
  }
  return live;
}

const segments = (key: StageKey) => key.value.map((v, k) => ({ from: key.from[k], value: v }));

describe("сдвиг сцены: оценка по правилу ядра", () => {
  it("медиана на месте совпадает с сортировкой", () => {
    for (let n = 1; n < 40; n++) {
      const xs = Array.from({ length: n }, (_, i) => Math.round(noise(i + n * 7, 10) * 10) / 10);
      const sorted = [...xs].sort((a, b) => a - b);
      const expected = n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      expect(medianInPlace(Float64Array.from(xs), n)).toBeCloseTo(expected, 12);
    }
  });

  it("тональность по высотному классу, октава — медианой: срыв меньшинства на октаву не мешает", () => {
    const est = (xs: number[]) => keyEstimate(Float64Array.from(xs), xs.length, new Float64Array(xs.length));
    expect(est(Array(9).fill(2.3))).toBeCloseTo(2.3, 9);
    expect(est([...Array(7).fill(0), ...Array(3).fill(12)])).toBeCloseTo(0, 9);
    expect(est([...Array(7).fill(-12.2), ...Array(3).fill(-0.2)])).toBeCloseTo(-12.2, 9);
    // Разности по обе стороны от ±6 — один и тот же высотный класс.
    expect(Math.abs(est([5.9, 5.8, -5.9, -5.8, 6, 6]))).toBeGreaterThan(5.7);
  });
});

describe("сдвиг сцены: старт", () => {
  it("до 1 с озвученных кадров сдвига нет и линия не рисуется; первая оценка — для всех прежних кадров", () => {
    const f0 = melody(4);
    const all = sing(f0, () => 3);
    const key = createStageKey(HOP);
    const path = createVoicePath();
    const into = { off: new Float64Array(8) };
    let voiced = 0;
    let firstAt = NaN;
    feed(key, all, f0, 6, (live) => {
      voiced = live.filter((f, i) => f.midi !== null && f0[i] !== null).length * HOP;
      voicePath(path, live);
      const ready = stageOffsets(key, path, into);
      if (voiced < 0.9) {
        expect(ready, `${voiced.toFixed(2)} с голоса: линия ещё не рисуется`).toBe(false);
        expect(stageKeyAt(key, live.at(-1)!.t)).toBeNaN();
      }
      if (ready && Number.isNaN(firstAt)) firstAt = voiced;
    });
    // Около секунды голоса: и не сразу (первая оценка по 0,1 с скачет), и не заметно позже.
    expect(firstAt).toBeGreaterThanOrEqual(0.9);
    expect(firstAt).toBeLessThanOrEqual(1.2);
    expect(stageKeyAt(key, 0)).toBe(3);
    expect(segments(key)).toEqual([{ from: -Infinity, value: 3 }]);
  });

  it("сдвиг — целые полутоны", () => {
    for (const [shift, expected] of [[2.3, 2], [2.7, 3], [-11.6, -12], [0.4, 0], [-4.45, -4]] as const) {
      const f0 = melody(6);
      const key = createStageKey(HOP);
      feed(key, sing(f0, () => shift, 0.1), f0);
      expect(segments(key), `певец на ${shift}`).toEqual([{ from: -Infinity, value: expected }]);
    }
  });

  it("новая попытка (кадры заново): прежний сдвиг сразу для всех новых кадров, окно оценки остаётся", () => {
    const f0 = melody(6);
    const key = createStageKey(HOP);
    feed(key, sing(f0, () => -5), f0);
    expect(key.offset).toBe(-5);
    const size = key.size;
    const again: F[] = [];
    updateStageKey(key, again, f0, HOP);
    expect(stageKeyAt(key, 0)).toBe(-5);
    const path = voicePath(createVoicePath(), sing(f0, () => -5).slice(0, 30));
    expect(stageOffsets(key, path, { off: new Float64Array(1) })).toBe(true);
    expect(key.size).toBe(size);
  });

  it("короткие круги тренировки (0,6 с голоса за круг): сдвиг появляется во втором круге и остаётся", () => {
    const f0 = Array.from({ length: 300 }, (_, i) => (i >= 100 && i < 160 ? 64 : null));
    const round = sing(f0, () => 2).map((f) => ({ ...f }));
    const key = createStageKey(HOP);
    feed(key, round, f0);
    expect(stageKeyAt(key, 1.2), "первый круг: голоса меньше секунды").toBeNaN();
    feed(key, round.map((f) => ({ ...f })), f0);
    expect(stageKeyAt(key, 1.0)).toBe(2);
    feed(key, round.map((f) => ({ ...f })), f0);
    expect(segments(key), "третий круг: сдвиг с первого кадра").toEqual([{ from: -Infinity, value: 2 }]);
  });

  it("начальный сдвиг (тренировка: тональность из оценки попытки): линия видна сразу, дальше обычные правила", () => {
    const key = createStageKey(HOP);
    seedStageKey(key, 2.4);
    expect(stageKeyAt(key, 0)).toBe(2);
    seedStageKey(key, 7);
    expect(key.offset, "посев не перебивает уже известный сдвиг").toBe(2);
    const f0 = Array.from({ length: 2000 }, (_, i) => 60 + ((i / 40) | 0) % 5);
    feed(key, sing(f0, () => 2, 0.1).slice(0, 300), f0);
    expect(key.value).toEqual([2]);
    const other = createStageKey(HOP);
    seedStageKey(other, -0.3);
    feed(other, sing(f0, () => 5, 0.1), f0);
    expect(other.value, "певец поёт выше, чем в попытке: сдвиг меняется с удержанием").toEqual([0, 5]);
    expect(other.from[1]).toBeGreaterThanOrEqual(1.5);
  });
});

describe("сдвиг сцены: устойчивость", () => {
  it("фразы и паузы не меняют сдвиг (30 с, вибрато и шум)", () => {
    const f0 = melody(30);
    const key = createStageKey(HOP);
    feed(key, sing(f0, () => 4, 0.3), f0);
    expect(segments(key)).toEqual([{ from: -Infinity, value: 4 }]);
  });

  it("фальшивые 2 секунды (на 4 и на 1 полутон) не меняют сдвиг", () => {
    for (const off of [4, 1, -3]) {
      const f0 = melody(20);
      const key = createStageKey(HOP);
      feed(key, sing(f0, (t) => (t >= 8 && t < 10 ? off : 0)), f0);
      expect(segments(key), `фальшь на ${off}`).toEqual([{ from: -Infinity, value: 0 }]);
    }
  });

  it("срывы на октаву (по 1 с каждые 4 с) не меняют сдвиг; певец на октаву ниже — сдвиг −12", () => {
    const f0 = melody(24);
    const key = createStageKey(HOP);
    feed(key, sing(f0, (t) => (t % 4 >= 3 ? 12 : 0)), f0);
    expect(segments(key)).toEqual([{ from: -Infinity, value: 0 }]);
    const low = createStageKey(HOP);
    feed(low, sing(f0, (t) => (t >= 9 && t < 10.5 ? 0 : -12)), f0);
    expect(segments(low)).toEqual([{ from: -Infinity, value: -12 }]);
  });

  it("оценка у границы полутона (2,45…2,55) не переключает сдвиг туда и обратно", () => {
    // Певец медленно гуляет вокруг середины между 2 и 3 полутонами: по 10 с на каждой стороне.
    const f0 = melody(40);
    const key = createStageKey(HOP);
    feed(key, sing(f0, (t) => (Math.floor(t / 10) % 2 ? 2.55 : 2.45), 0.05), f0);
    expect(segments(key)).toEqual([{ from: -Infinity, value: 2 }]);
    const fast = createStageKey(HOP);
    feed(fast, sing(f0, (t) => (Math.floor(t) % 2 ? 2.45 : 2.55), 0.05), f0);
    expect(fast.value).toHaveLength(1);
  });
});

describe("сдвиг сцены: смена тональности", () => {
  it("новая тональность принимается после удержания, только для новых кадров", () => {
    // Без пауз: окно 6 с голоса, медиана перевешивает через 3 с, ещё 2 с удержания.
    const f0 = Array.from({ length: 2000 }, (_, i) => 60 + ((i / 40) | 0) % 5);
    const key = createStageKey(HOP);
    const all = sing(f0, (t) => (t >= 8 ? 3 : 0), 0.1);
    feed(key, all, f0);
    expect(key.value).toEqual([0, 3]);
    const at = key.from[1];
    // Окно перевешивает через половину своей длины (3 с), потом удержание (не меньше 1,5 с).
    expect(STAGE_KEY.holdS).toBeGreaterThanOrEqual(1.5);
    expect(at - 8).toBeGreaterThanOrEqual(3 + 1.5);
    expect(at - 8).toBeLessThanOrEqual(STAGE_KEY.windowS / 2 + STAGE_KEY.holdS + 0.5);
    for (const f of all) expect(stageKeyAt(key, f.t)).toBe(f.t < at ? 0 : 3);
  });

  it("смена короче окна и удержания (4 с) не принимается", () => {
    const f0 = Array.from({ length: 2000 }, (_, i) => 60 + ((i / 40) | 0) % 5);
    const key = createStageKey(HOP);
    feed(key, sing(f0, (t) => (t >= 8 && t < 12 ? 3 : 0), 0.1), f0);
    expect(key.value).toEqual([0]);
  });
});

describe("сдвиг сцены: уже нарисованные точки не двигаются", () => {
  it("высота каждой точки окна не меняется до конца попытки (фразы, смена тональности, срывы, фальшь)", () => {
    const f0 = melody(40);
    const all = sing(f0, (t) => (t >= 14 && t < 15 ? 17 : t >= 22 && t < 24 ? 6 : t >= 12 ? 5 : 2), 0.25);
    const key = createStageKey(HOP);
    const path = createVoicePath();
    const into = { off: new Float64Array(16) };
    /** Высота (голос − сдвиг) и сдвиг точки, когда она впервые нарисована. */
    const drawn = new Map<number, { y: number; off: number }>();
    let checked = 0;
    let breaks = 0;
    feed(key, all, f0, 6, (live) => {
      const now = live.at(-1)!.t;
      // Окно сцены: 2,25 с прошлого (как на ноутбуке), путь — с запасом 0,3 с слева.
      voicePath(path, live, 0, live.length, now - 2.55, now);
      if (!stageOffsets(key, path, into)) return;
      for (let k = 0; k < path.n; k++) {
        const t = path.t[k];
        // Крайние точки куска ещё досглаживаются следующим кадром; у левого края пути — свой край.
        if (t > now - 0.03 || t < now - 2.25) continue;
        const y = path.m[k] - into.off[k];
        const id = Math.round(t * 1000);
        const was = drawn.get(id);
        if (!was) drawn.set(id, { y, off: into.off[k] });
        else {
          expect(into.off[k], `сдвиг точки ${t.toFixed(2)} с`).toBe(was.off);
          expect(Math.abs(y - was.y), `высота точки ${t.toFixed(2)} с`).toBeLessThan(1e-9);
          checked++;
        }
        if (k > 0 && into.off[k] !== into.off[k - 1]) {
          expect(path.start[k], "на смене сдвига линия разрывается").toBe(1);
          breaks++;
        }
      }
    });
    expect(checked).toBeGreaterThan(10_000);
    expect(key.value.length, "смена тональности на 12-й секунде принята").toBeGreaterThanOrEqual(2);
    expect(key.value.at(-1)).toBe(5);
    expect(breaks).toBeGreaterThan(0);
  });

  it("кривая соперника (50 мс, массив пересоздаётся, паузы чужих ходов в «Вместе»)", () => {
    const f0 = melody(30);
    const key = createStageKey(0.05);
    const curve: F[] = [];
    for (let i = 0; i * 0.05 < 30; i++) {
      const t = Math.round(i * 50) / 1000;
      const r = f0[Math.round(t / HOP)];
      const turn = Math.floor(t / 2) % 2 === 0;
      curve.push({ t, midi: r == null || !turn ? null : r - 7 + noise(i, 0.2) });
      if (i % 4 === 3) updateStageKey(key, curve.slice(), f0, HOP);
    }
    updateStageKey(key, curve.slice(), f0, HOP);
    expect(segments(key)).toEqual([{ from: -Infinity, value: -7 }]);
    const version = key.version;
    updateStageKey(key, curve.map((f) => ({ ...f })), f0, HOP);
    expect(key.version, "тот же отрезок кривой в новом массиве — не новая попытка").toBe(version);
  });

  it("призрак: постоянный сдвиг из оценки его попытки", () => {
    const key = createStageKey(0.05);
    fixStageKey(key, 1.7);
    const version = key.version;
    fixStageKey(key, 1.7);
    expect(key.version).toBe(version);
    expect(stageKeyAt(key, 0)).toBe(1.7);
    expect(stageKeyAt(key, 25)).toBe(1.7);
  });
});
