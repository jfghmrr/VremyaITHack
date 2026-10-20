// График разбора (ResultTrace) рисует ориентир так же, как сцена: по displayCurve (сглаживание и
// мостики через короткие паузы внутри фразы), одной линией на кусок. Раньше каждый отрезок 20 мс
// рисовался отдельно по сырому f0, и на рваных эталонах вместо линии были серые бусины.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUMP } from "../src/lib/ui/reference-line";
import { traceSeries } from "../src/lib/ui/series";
import type { ScoreResult, Song } from "../src/lib/scoring/types";

const root = new URL("../static/songs/", import.meta.url);
const song = (id: string): Song => JSON.parse(readFileSync(new URL(`${id}/reference.json`, root), "utf8"));

/** Куски линии, как их рисует ResultTrace: подряд без пропуска и без скачка от JUMP полутона. */
function parts(values: (number | null)[]) {
  let count = 0;
  let prev: number | null = null;
  for (const v of values) {
    if (v !== null && (prev === null || Math.abs(v - prev) >= JUMP)) count++;
    prev = v;
  }
  return count;
}

const result = (s: Song, shift = 0): ScoreResult =>
  ({ lag: 0, shiftCurve: s.f0_midi.map(() => shift) }) as unknown as ScoreResult;

describe("ориентир на графике разбора", () => {
  for (const id of ["cn-1000-years", "va-angel", "jw-as-i-am"]) {
    it(`${id}: линия ориентира — меньше кусков, чем сырой эталон, и в твоей тональности`, () => {
      const s = song(id);
      const data = traceSeries(s, [], result(s, 2));
      const raw = parts(data.map((p) => p.target));
      const line = parts(data.map((p) => p.line));
      expect(line).toBeLessThan(raw);
      // Сдвиг тональности применён и к линии: она рядом с ориентиром, а не с исходной высотой.
      const pairs = data.filter((p) => p.line !== null && p.target !== null);
      const offsets = pairs.map((p) => Math.abs(p.line! - p.target!));
      offsets.sort((a, b) => a - b);
      expect(offsets[Math.floor(offsets.length / 2)]).toBeLessThan(0.3);
    });
  }

  it("паузы между фразами остаются разрывами", () => {
    const s = song("cn-1000-years");
    const data = traceSeries(s, [], result(s));
    for (let k = 1; k < s.phrases.length; k++) {
      const gap = s.phrases[k].start_s - s.phrases[k - 1].end_s;
      if (gap < 0.2) continue;
      const mid = (s.phrases[k - 1].end_s + s.phrases[k].start_s) / 2;
      const p = data.reduce((best, q) => (Math.abs(q.t - mid) < Math.abs(best.t - mid) ? q : best));
      expect(p.line, `пауза ${k} около ${mid.toFixed(2)} с`).toBeNull();
    }
  });
});
