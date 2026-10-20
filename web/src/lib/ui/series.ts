// Ряды для графиков результата. Только отображение: оценку считает ядро.
import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";
import { displayCurve } from "./reference-line";

/** Ближайший кадр в пределах 35 мс к каждой точке сетки эталона со сдвигом lag. */
export function alignForDisplay(frames: PitchFrame[], length: number, hop: number, lag: number) {
  const sorted = frames.filter((f) => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
  let p = 0;
  return Array.from({ length }, (_, i) => {
    const t = i * hop + lag;
    while (p + 1 < sorted.length && Math.abs(sorted[p + 1].t - t) <= Math.abs(sorted[p].t - t)) p++;
    return sorted[p] && Math.abs(sorted[p].t - t) <= 0.035 ? sorted[p].midi : null;
  });
}

export interface TracePoint {
  t: number;
  target: number | null;
  /** Линия ориентира для рисования, как на сцене (displayCurve: сглаживание и мостики внутри фразы), в твоей тональности. */
  line: number | null;
  user: number | null;
  rival: number | null;
}

export function traceSeries(song: Song, frames: PitchFrame[], result: ScoreResult, rival?: { frames: PitchFrame[]; result: ScoreResult } | null): TracePoint[] {
  const hop = song.hop_ms / 1000;
  const user = alignForDisplay(frames, song.f0_midi.length, hop, result.lag);
  const other = rival ? alignForDisplay(rival.frames, song.f0_midi.length, hop, rival.result.lag) : null;
  const line = displayCurve(song.f0_midi, hop, song.phrases ?? []);
  const out: TracePoint[] = [];
  for (let i = 0; i < song.f0_midi.length; i += 2) {
    const r = song.f0_midi[i];
    const l = line[i];
    const o = other?.[i];
    out.push({
      t: i * hop,
      target: r === null ? null : r + result.shiftCurve[i],
      line: l === null ? null : l + result.shiftCurve[i],
      user: user[i],
      // Соперник переносится в твою тональность: сравнивается форма мелодии.
      rival: o != null && rival ? o - rival.result.shiftCurve[i] + result.shiftCurve[i] : null,
    });
  }
  return out;
}
