// Уровень голоса: ограниченное усиление анализа для тихого микрофона и ровная громкость записи
// при переслушивании.
import { describe, expect, it } from "vitest";
import { ANALYSIS, analysisGain, createNoteMeter, gateFor, limit, normalizeRecording, PLAYBACK, playbackGain } from "../src/lib/audio/level";
import { createPitchTracker } from "../src/lib/audio/pitch";

const RATE = 48_000;
/** Окна детектора 2048 отсчётов с шагом 10 мс: синус 220 Гц со средним квадратичным rms. */
function frames(rms: number, seconds: number, hz = 220) {
  const amp = rms * Math.SQRT2;
  const hop = Math.round(RATE * 0.01);
  const out: Float32Array[] = [];
  for (let start = 0; start < seconds * RATE; start += hop) {
    const w = new Float32Array(2048);
    for (let i = 0; i < w.length; i++) w[i] = amp * Math.sin((2 * Math.PI * hz * (start + i)) / RATE);
    out.push(w);
  }
  return out;
}
/** Белый шум (ясной высоты нет). */
function noise(rms: number, seconds: number) {
  const out: Float32Array[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; k < seconds * 100; k++) out.push(Float32Array.from({ length: 2048 }, () => rnd() * rms * Math.sqrt(3)));
  return out;
}
// Часы окон: детектор решает кадр с задержкой в несколько окон (pitch.ts, VOICING.delay) и
// возвращает его со временем этого кадра. Доля голоса считается по кадрам самого отрезка: первые
// ответы на новом отрезке — ещё кадры предыдущего.
let clock = 0;
const run = (track: ReturnType<typeof createPitchTracker>, list: Float32Array[]) => list.map((w) => track(w, (clock += 0.01)));
const voicedShare = (track: ReturnType<typeof createPitchTracker>, list: Float32Array[]) => {
  const from = clock;
  const own = run(track, list).filter((f) => f.ready && f.time > from + 1e-9);
  return own.filter((f) => f.midi !== null).length / own.length;
};
const lastGain = (track: ReturnType<typeof createPitchTracker>, list: Float32Array[]) => run(track, list).at(-1)!.gain;

describe("порог громкости детектора", () => {
  it("порог попытки: без замера — прежний, после замера — на 11 дБ ниже ноты, от 0.002 до 0.008", () => {
    expect(gateFor(0)).toBe(ANALYSIS.gate);
    expect(gateFor(0.001)).toBe(ANALYSIS.gate); // ниже шума тракта — не нота
    expect(gateFor(0.1)).toBe(ANALYSIS.gate); // громкий певец — прежний порог
    expect(gateFor(0.02)).toBeCloseTo(0.02 * ANALYSIS.ratio, 6);
    expect(gateFor(0.004)).toBe(ANALYSIS.minGate); // не ниже ×4
    expect(analysisGain(ANALYSIS.gate)).toBe(1);
    expect(analysisGain(ANALYSIS.minGate)).toBe(4);
  });

  it("тишина на проверке микрофона: усиления нет, порог прежний", () => {
    const track = createPitchTracker(RATE);
    track.measure(true);
    const out = run(track, frames(0, 3));
    expect(out.every((f) => f.midi === null)).toBe(true);
    expect(out.at(-1)!.gain).toBe(1);
  });

  it("ясный тихий тон без замера (практика, дуэль, песня без проверки) — прежний порог", () => {
    const track = createPitchTracker(RATE);
    expect(voicedShare(track, frames(0.004, 2))).toBe(0);
    expect(lastGain(track, frames(0.004, 0.1))).toBe(1);
  });

  it("тихий певец, нота замерена: порог ниже и не меняется до конца попытки", () => {
    const track = createPitchTracker(RATE);
    track.measure(true);
    // RMS 0.004 — ниже прежнего порога 0.008: после замера протяжной ноты голос распознаётся.
    run(track, frames(0.004, 1));
    expect(voicedShare(track, frames(0.004, 1))).toBeGreaterThan(0.9);
    const last = track(frames(0.004, 0.02)[0]);
    expect(last.midi).toBeCloseTo(57, 0); // A3
    expect(last.gain).toBe(4);
    track.measure(false); // попытка началась: порог зафиксирован
    run(track, frames(0.08, 2)); // громкое пение в песне порог не поднимает
    expect(lastGain(track, frames(0, 0.1))).toBe(4); // и тишина его не меняет
    expect(voicedShare(track, frames(0.004, 1))).toBeGreaterThan(0.9);
    expect(voicedShare(track, frames(0.0012, 1))).toBe(0); // ниже нижнего порога 0.002
  });

  it("нота, прерванная прослушиванием песни, не складывается из кусков до и после паузы замера", () => {
    const track = createPitchTracker(RATE);
    track.measure(true);
    run(track, frames(0.004, (ANALYSIS.note - 10) / 100)); // 0.3 с ясной ноты
    track.measure(false); // включили фрагмент песни
    track.measure(true); // фрагмент закончился
    run(track, frames(0.004, 0.2)); // ещё 0.2 с: вместе 0.5 с, но не подряд
    expect(lastGain(track, frames(0.004, 0.1))).toBe(1);
    run(track, frames(0.004, ANALYSIS.note / 100)); // целая нота после перерыва замеряется
    expect(lastGain(track, frames(0.004, 0.1))).toBe(4);
  });

  it("громкий певец, нота замерена: порог прежний, тихий звук на 11+ дБ ниже не голос", () => {
    const track = createPitchTracker(RATE);
    track.measure(true);
    run(track, frames(0.05, 1));
    expect(lastGain(track, frames(0.05, 0.1))).toBe(1);
    track.measure(false);
    // Подсказка из наушников в паузе: ясный звук RMS 0.006 ниже прежнего порога.
    expect(voicedShare(track, frames(0.006, 1))).toBe(0);
  });

  it("короткий всплеск и шум не замеряются как нота", () => {
    const track = createPitchTracker(RATE);
    track.measure(true);
    run(track, frames(0.004, (ANALYSIS.note - 5) / 100));
    run(track, noise(0.004, 1));
    expect(lastGain(track, noise(0.004, 0.1))).toBe(1);
    const meter = createNoteMeter();
    for (let i = 0; i < 300; i++) meter.update(0.5, false);
    expect(meter.level).toBe(0);
    for (let i = 0; i < ANALYSIS.note; i++) meter.update(0.004, true);
    expect(meter.level).toBeCloseTo(0.004, 6);
    for (let i = 0; i < ANALYSIS.note; i++) meter.update(0.002, true);
    expect(meter.level, "громкая нота остаётся замером").toBeCloseTo(0.004, 6);
  });
});

describe("громкость записи при переслушивании", () => {
  const tone = (amp: number, seconds = 2) => {
    const s = new Float32Array(Math.round(seconds * RATE));
    for (let i = 0; i < s.length; i++) s[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
    return s;
  };

  it("тихая запись поднимается до цели, громкая не меняется, пауза не влияет", () => {
    const quiet = tone(0.02 * Math.SQRT2); // RMS 0.02 → ×5
    expect(playbackGain(quiet, RATE)).toBeCloseTo(PLAYBACK.target / 0.02, 1);
    expect(playbackGain(tone(0.3), RATE)).toBe(1);
    const withPause = new Float32Array(quiet.length * 2);
    withPause.set(quiet, quiet.length);
    expect(playbackGain(withPause, RATE)).toBeCloseTo(playbackGain(quiet, RATE), 1);
    expect(playbackGain(new Float32Array(RATE), RATE)).toBe(1);
  });

  it("усиление не больше ×8", () => {
    expect(playbackGain(tone(0.003 * Math.SQRT2), RATE)).toBe(PLAYBACK.maxGain);
  });

  it("ограничитель: тихое без изменений, пики не выше потолка, монотонно", () => {
    expect(limit(0.3)).toBe(0.3);
    expect(limit(-0.6)).toBe(-0.6);
    expect(limit(5)).toBeLessThanOrEqual(PLAYBACK.ceiling);
    expect(limit(-5)).toBeGreaterThanOrEqual(-PLAYBACK.ceiling);
    expect(limit(0.8)).toBeGreaterThan(limit(0.7));
    const out = normalizeRecording(tone(0.2), RATE); // ×~0.7 → без усиления, пики 0.2
    expect(Math.max(...out)).toBeCloseTo(0.2, 3);
    const loud = normalizeRecording(tone(0.05 * Math.SQRT2), RATE); // ×2 → пики 0.14
    expect(Math.max(...loud)).toBeLessThanOrEqual(PLAYBACK.ceiling);
  });

  it("исходная запись не меняется", () => {
    const s = tone(0.01);
    const copy = s.slice();
    normalizeRecording(s, RATE);
    expect(s).toEqual(copy);
  });
});
