// «Вместе»: ходы из расписания сервера, отправка только своих точек, эталон партии,
// подсказка перед ходом и линии для «Прослушать всю песню».
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { coopLines, cueAt, inTurns, maskPoints, ownerOfLine, partSong, turnAt } from "../src/lib/duel/coop";
import { initWasmSync, scorePerformance } from "../src/lib/scoring/core";
import type { Turn } from "../src/lib/api/types";
import type { PitchFrame, Song } from "../src/lib/scoring/types";

// Расписание как его присылает сервер: окна строк с запасом, чередование с создателя комнаты.
const turns: Turn[] = [
  { slot: 0, start_s: 0.5, end_s: 3.95, lines: [0] },
  { slot: 1, start_s: 3.95, end_s: 7.9, lines: [1, 2] },
  { slot: 0, start_s: 8.5, end_s: 12.0, lines: [3] },
];

beforeAll(() => {
  initWasmSync(readFileSync(new URL("../src/lib/wasm/scoring_bg.wasm", import.meta.url)));
});

it("чей ход: окна полуоткрыты, вне ходов — никто", () => {
  expect(turnAt(turns, 0.2)).toBe(-1);
  expect(turnAt(turns, 0.5)).toBe(0);
  expect(turnAt(turns, 3.95)).toBe(1);
  expect(turnAt(turns, 8.2)).toBe(-1);
  expect(inTurns(turns, 0, 3.9)).toBe(true);
  expect(inTurns(turns, 0, 3.95)).toBe(false);
  expect(inTurns(turns, 1, 3.95)).toBe(true);
  expect(ownerOfLine(turns, 2)).toBe(1);
  expect(ownerOfLine(turns, 3)).toBe(0);
  expect(ownerOfLine(turns, 9)).toBe(null);
});

it("на сервер уходят только свои точки: вне своих ходов — пауза", () => {
  // Точки с индекса 70 (3,5 с) по 80 (4,0 с): ход A до 3,95 с.
  const points = Array.from({ length: 10 }, (_, k) => 600 + k);
  const mine = maskPoints(points, 70, turns, 0);
  expect(mine).toEqual([600, 601, 602, 603, 604, 605, 606, 607, 608, null]);
  const theirs = maskPoints(points, 70, turns, 1);
  expect(theirs.slice(0, 9).every((p) => p === null)).toBe(true);
  expect(theirs[9]).toBe(609);
});

it("подсказка перед ходом: заранее и в начале хода, кто поёт", () => {
  expect(cueAt(turns, 0, 0.0)).toEqual({ turn: 0, mine: true });
  expect(cueAt(turns, 0, 2.0)).toBe(null);
  expect(cueAt(turns, 0, 2.5)).toEqual({ turn: 1, mine: false });
  expect(cueAt(turns, 1, 7.4)).toEqual({ turn: 2, mine: false });
  expect(cueAt(turns, 1, 12.5)).toBe(null);
});

/** Две ноты по 3 с: первая — ход A, вторая — ход B (как в тесте сервера). */
function song(): Song {
  const f0 = Array.from({ length: 800 }, (_, i) =>
    i >= 50 && i < 350 ? 60 + ((Math.floor(i / 50) % 3) * 2) : i >= 450 && i < 750 ? 64 + ((Math.floor(i / 50) % 3) * 2) : null,
  );
  return { id: "t", title: "", artist: "", hop_ms: 10, duration_s: 8, f0_midi: f0, phrases: [{ start_s: 0.5, end_s: 3.5 }, { start_s: 4.5, end_s: 7.5 }], lyrics: [], backing: "" };
}
const two: Turn[] = [
  { slot: 0, start_s: 0.1, end_s: 4.0, lines: [0] },
  { slot: 1, start_s: 4.0, end_s: 7.9, lines: [1] },
];
const sung = (s: Song, shift: number, sing: (t: number) => boolean): PitchFrame[] =>
  Array.from({ length: 160 }, (_, i) => {
    const t = i * 0.05;
    const r = s.f0_midi[Math.round(t * 100)];
    return { t, midi: r != null && sing(t) ? r + shift : null };
  });

it("эталон партии: высота и фразы только в своих ходах; та же оценка, что на сервере", () => {
  const s = song();
  const a = partSong(s, two, 0);
  expect(a.f0_midi[100]).not.toBeNull();
  expect(a.f0_midi[500]).toBeNull();
  expect(a.phrases).toEqual([{ start_s: 0.5, end_s: 3.5 }]);
  expect(partSong(s, two, 1).phrases).toEqual([{ start_s: 4.5, end_s: 7.5 }]);
  expect(s.f0_midi[500]).not.toBeNull();
  // Своя партия спета — высокий балл; молчание в свои ходы — не выше 30.
  expect(scorePerformance(sung(s, -3, (t) => inTurns(two, 0, t)), a).score).toBeGreaterThan(90);
  expect(scorePerformance(sung(s, 0, (t) => inTurns(two, 0, t)), partSong(s, two, 1)).score).toBeLessThanOrEqual(30);
});

it("«Прослушать всю песню»: каждый звучит только в свои ходы, задержка вычтена, тональность минуса", () => {
  const frames = (midi: number) => Array.from({ length: 160 }, (_, i) => ({ t: i * 0.05, midi }));
  const lines = coopLines(two, [
    { slot: 0, frames: frames(57), lag: 0.1, shift: -3 },
    { slot: 1, frames: frames(72), lag: 0, shift: 2.5 },
  ]);
  expect(lines).toHaveLength(2);
  const [a, b] = lines;
  // A: кадры сдвинуты на задержку и звучат только в окне A.
  expect(a.frames.find((f) => Math.abs(f.t - 1.0) < 1e-9)?.midi).toBe(57);
  expect(a.frames.find((f) => Math.abs(f.t - 5.0) < 1e-9)?.midi).toBe(null);
  expect(b.frames.find((f) => Math.abs(f.t - 1.0) < 1e-9)?.midi).toBe(null);
  expect(b.frames.find((f) => Math.abs(f.t - 5.0) < 1e-9)?.midi).toBe(72);
  // Тональность каждого подстроена под минус (свой сдвиг вычитается).
  expect(a.shift).toBe(3);
  expect(b.shift).toBe(-2.5);
});
