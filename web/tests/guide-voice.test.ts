import { describe, expect, it } from "vitest";
import { GUIDE_PEAK, GUIDE_RATE, guideSegments, guideShift, renderGuide } from "../src/lib/audio/guide";

const HOP = 0.01;
/** Звук и автокорреляция считаются по всем отсчётам: на загруженном Mac дольше 5 с по умолчанию. */
const HEAVY_TIMEOUT_MS = 60_000;
/** Эталон на сетке 10 мс из отрезков [от, до, высота]; вне отрезков — пауза. */
function reference(duration: number, notes: [number, number, number][]): (number | null)[] {
  return Array.from({ length: Math.round(duration / HOP) }, (_, i) => {
    const t = i * HOP;
    return notes.find(([a, b]) => t >= a - 1e-9 && t < b - 1e-9)?.[2] ?? null;
  });
}

describe("ориентир: ноты из эталона", () => {
  it("короткие паузы (согласные) склеиваются в легато, длинные разделяют фразы", () => {
    const f0 = reference(4, [[0.5, 1.0, 60], [1.08, 1.5, 62], [2.0, 2.6, 64]]);
    const segments = guideSegments(f0, HOP, 0);
    expect(segments.map((s) => [s.start, s.end])).toEqual([[0.5, 1.5], [2, 2.6]]);
    // В склеенной паузе высота идёт от 60 к 62, без провала.
    const gap = segments[0].midi.slice(50, 58);
    expect(Math.min(...gap)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...gap)).toBeLessThanOrEqual(62);
  });

  it("одиночные всплески короче 80 мс не звучат, октавный скачок на пару кадров сглаживается", () => {
    const f0 = reference(3, [[0.2, 0.25, 70], [1, 2, 60]]);
    for (let i = 140; i < 143; i++) f0[i] = 72;
    const [only, ...rest] = guideSegments(f0, HOP, 0);
    expect(rest).toEqual([]);
    expect([only.start, only.end]).toEqual([1, 2]);
    expect(Math.max(...only.midi)).toBeLessThan(61);
  });

  it("весь ориентир в одной тональности певца: общий сдвиг, а не местный", () => {
    const f0 = reference(2, [[0.5, 1.5, 60]]);
    const [s] = guideSegments(f0, HOP, -12);
    expect(Math.max(...s.midi)).toBeCloseTo(48, 5);
    expect(Math.min(...s.midi)).toBeCloseTo(48, 5);
    expect(guideShift({ registerShift: -11.96 })).toBe(-12);
    expect(guideShift({ registerShift: Number.NaN })).toBe(0);
    expect(guideSegments([], HOP, 0)).toEqual([]);
  });
});

describe("ориентир: звук", () => {
  const melody = reference(6, [[0.5, 1.2, 57], [1.25, 2.0, 64], [2.0, 2.5, 69], [3.0, 3.3, 45], [4.0, 5.5, 72]]);
  const samples = renderGuide(guideSegments(melody, HOP, 0), 6);

  it("без щелчков и перегрузки: пик ниже 0 dBFS, соседние отсчёты без скачков", () => {
    expect(samples.length).toBe(6 * GUIDE_RATE);
    let peak = 0;
    let jump = 0;
    let broken = 0;
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) broken++;
      peak = Math.max(peak, Math.abs(samples[i]));
      if (i) jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
    }
    expect(broken).toBe(0);
    expect(peak).toBeLessThanOrEqual(GUIDE_PEAK + 1e-6);
    expect(peak).toBeGreaterThan(GUIDE_PEAK * 0.5);
    expect(jump).toBeLessThan(0.12);
  }, HEAVY_TIMEOUT_MS);

  it("каждая фраза начинается и заканчивается с нуля, в паузах тишина", () => {
    const at = (t: number) => samples[Math.round(t * GUIDE_RATE)];
    const window = (a: number, b: number) => Math.max(...samples.slice(Math.round(a * GUIDE_RATE), Math.round(b * GUIDE_RATE)).map(Math.abs));
    expect(Math.abs(at(0.5))).toBeLessThan(0.005);
    expect(window(0, 0.49)).toBe(0);
    expect(window(2.7, 2.99)).toBe(0);
    expect(window(3.45, 3.99)).toBe(0);
    expect(window(0.6, 1.1)).toBeGreaterThan(0.1);
    // Внутри фразы звук не прерывается и при смене ноты (легато).
    expect(window(1.95, 2.05)).toBeGreaterThan(0.1);
  });

  it("высота звучания следует за нотами", () => {
    // Основной тон по автокорреляции: первый пик не ниже 90 % наибольшего.
    const pitchAt = (a: number, b: number) => {
      const x = samples.slice(Math.round(a * GUIDE_RATE), Math.round(b * GUIDE_RATE));
      const r: number[] = [];
      for (let lag = Math.floor(GUIDE_RATE / 1000); lag <= Math.ceil(GUIDE_RATE / 80); lag++) {
        let sum = 0;
        for (let i = 0; i + lag < x.length; i++) sum += x[i] * x[i + lag];
        r[lag] = sum;
      }
      const best = Math.max(...r.filter(Number.isFinite));
      const lag = r.findIndex((v, i) => Number.isFinite(v) && v >= 0.9 * best && v >= (r[i - 1] ?? -Infinity) && v >= (r[i + 1] ?? -Infinity));
      return GUIDE_RATE / lag;
    };
    // 220 Гц (нота 57) и 440 Гц (нота 69).
    expect(Math.abs(pitchAt(0.7, 1.1) - 220)).toBeLessThan(4);
    expect(Math.abs(pitchAt(2.1, 2.4) - 440)).toBeLessThan(10);
  }, HEAVY_TIMEOUT_MS);
});
