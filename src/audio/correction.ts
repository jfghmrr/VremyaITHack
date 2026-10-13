import type { PitchFrame, Song } from "../types";
import type { ScoreResult } from "../scoring";
import { resample } from "../scoring/alignment";
import { clamp, smooth } from "../scoring/math";
export function correctionCurve(
  frames: PitchFrame[],
  song: Song,
  result: ScoreResult,
) {
  const user = resample(
    frames,
    song.f0_midi.length,
    song.hop_ms / 1000,
    result.lag,
  );
  const raw = song.f0_midi.map((ref, i) =>
    ref === null || user[i] === null
      ? null
      : clamp(ref + result.shiftCurve[i] - user[i]!, -12, 12),
  );
  const filtered = smooth(raw, 3);
  return filtered
    .filter((_, i) => i % 2 === 0)
    .map((pitch, i) => ({
      t: i * 0.02,
      pitch,
      target:
        song.f0_midi[i * 2] === null
          ? null
          : song.f0_midi[i * 2]! + result.shiftCurve[i * 2],
    }));
}
