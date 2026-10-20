// Разбор дуэли: сравнение по осям, вывод, общие трудные места и озвучивание линий.
import { expect, it } from "vitest";
import { compareAxes, hardestMoments, verdict } from "../src/lib/duel/analysis";
import { voiceSchedule } from "../src/lib/audio/curve-voice";
import type { Moment, ScoreResult } from "../src/lib/scoring/types";

const moment = (start_s: number, loss: number, reason: Moment["reason"] = "pitch"): Moment => ({ start_s, end_s: start_s + 2, phrase: 1, loss, reason, text: "" });
const result = (moments: Moment[]) => ({ moments }) as unknown as ScoreResult;

it("оси: баллы, разница, кто сильнее; почти равные — вровень", () => {
  const rows = compareAxes({ intervals: 0.8, rhythm: 0.5, stability: 0.705, coverage: 0.9 }, { intervals: 0.6, rhythm: 0.7, stability: 0.7, coverage: 0.9 });
  expect(rows.map((r) => [r.key, r.mine, r.theirs, r.diff, r.better])).toEqual([
    ["intervals", 80, 60, 20, "mine"],
    ["rhythm", 50, 70, -20, "theirs"],
    ["stability", 71, 70, 1, "tie"],
    ["coverage", 90, 90, 0, "tie"],
  ]);
  expect(rows.reduce((s, r) => s + r.weight, 0)).toBe(100);
  expect(verdict(rows, "Борис")).toBe("Ты сильнее: интервалы (+20). Борис сильнее: ритм (+20).");
});

it("оси без данных у соперника (неполная кривая): сравнение не выдумывается", () => {
  const rows = compareAxes({ intervals: 0.8, rhythm: 0.5, stability: 0.7, coverage: 0.9 }, null);
  expect(rows.every((r) => r.theirs === null && r.diff === null && r.better === null)).toBe(true);
  expect(verdict(rows, "Борис")).toMatch(/нужны полные линии/);
});

it("трудные места: окна с наибольшей суммарной потерей обоих, по порядку времени", () => {
  const mine = result([moment(2, 0.3), moment(6, 0.05), moment(10, 0.1, "rhythm")]);
  const theirs = result([moment(6, 0.4, "missing"), moment(14, 0.02)]);
  const top = hardestMoments(mine, theirs, 3);
  expect(top.map((m) => [m.start_s, m.mine, m.theirs])).toEqual([
    [2, 0.3, 0],
    [6, 0.05, 0.4],
    [10, 0.1, 0],
  ]);
  expect(top[1].theirsMoment?.reason).toBe("missing");
  expect(hardestMoments(null, null)).toEqual([]);
});

it("озвучивание: кадры окна, частота по MIDI со сдвигом, паузы — тишина", () => {
  const frames = [{ t: 0.95, midi: 60 }, { t: 1, midi: 69 }, { t: 1.05, midi: null }, { t: 1.1, midi: 57 }, { t: 2, midi: 69 }];
  const s = voiceSchedule(frames, 1, 2);
  expect(s.map((p) => [Math.round(p.at * 100) / 100, p.hz === null ? null : Math.round(p.hz)])).toEqual([
    [0, 440],
    [0.05, null],
    [0.1, 220],
  ]);
  expect(Math.round(voiceSchedule(frames, 1, 1.01, 12)[0].hz!)).toBe(880);
});
