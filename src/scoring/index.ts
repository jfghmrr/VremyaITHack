import type { PitchFrame, Song, Phrase } from "../types";
import { SCORING as C } from "../config";
import {
  circularMedian,
  clamp,
  mean,
  median,
  quality,
  smooth,
  wrap,
} from "./math";
import { findLag, resample, rhythmOffsets } from "./alignment";
export interface Axes {
  intervals: number;
  rhythm: number;
  stability: number;
  coverage: number;
}
export interface Moment extends Phrase {
  phrase: number;
  loss: number;
  reason: "pitch" | "rhythm" | "missing";
  text: string;
}
export interface ScoreResult {
  score: number;
  axes: Axes;
  lag: number;
  shift: number;
  registerShift: number;
  shiftCurve: number[];
  errors: (number | null)[];
  seconds: { t: number; error: number; coverage: number }[];
  phrases: (Phrase & { score: number; shift: number })[];
  moments: Moment[];
  noteOffsets: { t: number; offset: number }[];
  constantTone: boolean;
}
export function scorePerformance(
  frames: PitchFrame[],
  song: Song,
): ScoreResult {
  const hop = song.hop_ms / 1000,
    ref = song.f0_midi,
    lag = findLag(frames, ref, hop),
    user = resample(frames, ref.length, hop, lag);
  const shiftCurve = new Array<number>(ref.length).fill(0);
  const phrases = song.phrases.length
    ? song.phrases
    : [{ start_s: 0, end_s: song.duration_s }];
  // Estimate per 100 ms from a 4-second neighbourhood, bounded by phrase breaks.
  for (let i = 0; i < ref.length; i += 10) {
    const t = i * hop,
      phrase = phrases.find((p) => t >= p.start_s && t <= p.end_s);
    const lo = Math.max(
      0,
      Math.ceil((phrase?.start_s ?? 0) / hop),
      i - Math.round(C.shiftWindow / 2 / hop),
    );
    const hi = Math.min(
      ref.length,
      Math.floor((phrase?.end_s ?? song.duration_s) / hop) + 1,
      i + Math.round(C.shiftWindow / 2 / hop),
    );
    const ds: number[] = [];
    for (let j = lo; j < hi; j += 2)
      if (ref[j] !== null && user[j] !== null) ds.push(user[j]! - ref[j]!);
    const key = circularMedian(ds);
    const full = key + 12 * Math.round(median(ds.map((d) => (d - key) / 12)));
    for (let j = i; j < Math.min(ref.length, i + 10); j++) shiftCurve[j] = full;
  }
  const raw = ref.map((r, i) =>
    r === null || user[i] === null ? null : user[i]! - r - shiftCurve[i],
  );
  // Smooth residual, not melody: transitions remain in the reference; normal vibrato is attenuated.
  const errors = smooth(raw, Math.round(C.smoothingSeconds / 2 / hop));
  let voiced = 0,
    covered = 0;
  const iq: number[] = [];
  ref.forEach((r, i) => {
    if (r === null) return;
    voiced++;
    if (user[i] !== null) covered++;
    iq.push(
      errors[i] === null
        ? 0
        : quality(errors[i]!, C.intervalGood, C.intervalBad),
    );
  });
  const coverage = covered / Math.max(1, voiced);
  const noteOffsets = rhythmOffsets(ref, user, shiftCurve, hop);
  const rhythm =
    coverage === 0
      ? 0
      : quality(
          median(noteOffsets.map((n) => Math.abs(n.offset))),
          C.rhythmGood,
          C.rhythmBad,
        ) * Math.min(1, coverage / 0.8);
  const phraseResults = phrases.map((p) => {
    const indices = ref
      .map((_, i) => i)
      .filter(
        (i) => i * hop >= p.start_s && i * hop < p.end_s && ref[i] !== null,
      );
    return {
      ...p,
      score:
        100 *
        mean(
          indices.map((i) =>
            errors[i] === null
              ? 0
              : quality(errors[i]!, C.intervalGood, C.intervalBad),
          ),
        ),
      shift: median(
        indices.filter((i) => user[i] !== null).map((i) => shiftCurve[i]),
      ),
    };
  });
  const drifts = phraseResults
    .slice(1)
    .map((p, i) => Math.abs(p.shift - phraseResults[i].shift));
  const longResiduals: number[] = [];
  for (let i = 0; i < ref.length;) {
    let j = i + 1;
    while (
      j < ref.length &&
      (ref[i] === null
        ? ref[j] === null
        : ref[j] !== null &&
          Math.abs(ref[j]! - ref[i]!) < C.referenceNoteTolerance)
    )
      j++;
    if (ref[i] !== null && (j - i) * hop > C.longNoteSeconds) {
      const e = errors
        .slice(i + 5, j - 5)
        .filter((v): v is number => v !== null);
      const center = median(e);
      longResiduals.push(...e.map((v) => Math.abs(v - center)));
    }
    i = j;
  }
  const stability =
    coverage === 0
      ? 0
      : quality(mean(longResiduals), C.stabilityGood, C.stabilityBad) *
        (1 - C.driftPenalty * clamp(mean(drifts) / C.driftBad));
  const userVoiced = user.filter((v): v is number => v !== null),
    refVoiced = ref.filter((v): v is number => v !== null);
  const spread = (xs: number[]) => {
    const center = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - center) ** 2)));
  };
  const constantTone =
    covered > 20 &&
    spread(userVoiced) < C.constantSpread &&
    spread(refVoiced) > C.referenceSpread;
  const axes = { intervals: mean(iq), rhythm, stability, coverage };
  let score =
    100 *
    (C.weights.intervals * axes.intervals +
      C.weights.rhythm * rhythm +
      C.weights.stability * stability +
      C.weights.coverage * coverage);
  if (coverage < C.coverageFloor || constantTone)
    score = Math.min(C.lowCoverageCap, score);
  const seconds = Array.from({ length: Math.ceil(song.duration_s) }, (_, s) => {
    const indices = ref
      .map((_, i) => i)
      .filter((i) => i * hop >= s && i * hop < s + 1 && ref[i] !== null);
    return {
      t: s,
      error: mean(
        indices.map((i) => (errors[i] === null ? 1.5 : Math.abs(errors[i]!))),
      ),
      coverage: indices.length
        ? indices.filter((i) => user[i] !== null).length / indices.length
        : 1,
    };
  });
  const moments: Moment[] = [];
  phrases.forEach((p, pi) => {
    for (let t = p.start_s; t < p.end_s - 0.15; t += 2) {
      const end = Math.min(p.end_s, t + 2);
      const indices = ref
        .map((_, i) => i)
        .filter((i) => i * hop >= t && i * hop < end && ref[i] !== null);
      if (!indices.length) continue;
      const cov =
        indices.filter((i) => user[i] !== null).length / indices.length;
      const e = mean(
        indices.map((i) => (errors[i] === null ? 1.5 : Math.abs(errors[i]!))),
      );
      const signed = median(
        indices.map((i) => errors[i]).filter((v): v is number => v !== null),
      );
      const timing = median(
        noteOffsets
          .filter((n) => n.t >= t && n.t < end)
          .map((n) => Math.abs(n.offset)),
      );
      const reason =
        cov < 0.65
          ? "missing"
          : timing > 0.12 && timing / 0.3 > e / 1.5
            ? "rhythm"
            : "pitch";
      const loss =
        0.45 *
          (1 -
            mean(
              indices.map((i) =>
                errors[i] === null
                  ? 0
                  : quality(errors[i]!, C.intervalGood, C.intervalBad),
              ),
            )) +
        0.25 * (1 - quality(timing, C.rhythmGood, C.rhythmBad)) +
        0.15 * (1 - cov);
      const text =
        reason === "missing"
          ? `Во фразе ${pi + 1} часть мелодии не слышна. Спой этот отрезок без паузы.`
          : reason === "rhythm"
            ? `Во фразе ${pi + 1} начала нот смещены примерно на ${Math.round(timing * 1000)} мс после вычета общей задержки.`
            : `Во фразе ${pi + 1} ты пел примерно на ${Math.round(Math.abs(signed) * 100)} центов ${signed < 0 ? "ниже" : "выше"} нужного относительно своей тональности.`;
      if (loss > 0.025)
        moments.push({
          start_s: t,
          end_s: end,
          phrase: pi + 1,
          loss,
          reason,
          text,
        });
    }
  });
  const selected: Moment[] = [];
  for (const m of moments.sort((a, b) => b.loss - a.loss))
    if (
      selected.length < 3 &&
      !selected.some((s) => m.start_s < s.end_s && m.end_s > s.start_s)
    )
      selected.push(m);
  const fullShift = median(
    shiftCurve.filter((_, i) => ref[i] !== null && user[i] !== null),
  );
  return {
    score: Math.round(score * 10) / 10,
    axes,
    lag,
    shift: wrap(fullShift),
    registerShift: fullShift,
    shiftCurve,
    errors,
    seconds,
    phrases: phraseResults,
    moments: selected.sort((a, b) => a.start_s - b.start_s),
    noteOffsets,
    constantTone,
  };
}
