import type { PitchFrame } from "../types";
import { SCORING } from "../config";
import { median } from "./math";
export function resample(
  frames: PitchFrame[],
  length: number,
  hop: number,
  lag = 0,
) {
  const sorted = frames
    .filter(
      (f) =>
        Number.isFinite(f.t) && (f.midi === null || Number.isFinite(f.midi)),
    )
    .sort((a, b) => a.t - b.t);
  let p = 0;
  return Array.from({ length }, (_, i) => {
    const t = i * hop + lag;
    while (
      p + 1 < sorted.length &&
      Math.abs(sorted[p + 1].t - t) <= Math.abs(sorted[p].t - t)
    )
      p++;
    return sorted[p] && Math.abs(sorted[p].t - t) <= 0.035
      ? sorted[p].midi
      : null;
  });
}
function delta(xs: (number | null)[], i: number) {
  const a = xs[i - 3],
    b = xs[i + 3];
  return a != null && b != null ? b - a : 0;
}
export function findLag(
  frames: PitchFrame[],
  ref: (number | null)[],
  hop: number,
) {
  let best = -Infinity,
    lag = 0;
  for (
    let k = -Math.round(SCORING.maxLag / hop);
    k <= Math.round(SCORING.maxLag / hop);
    k++
  ) {
    const user = resample(frames, ref.length, hop, k * hop);
    let dot = 0,
      rr = 0,
      uu = 0,
      both = 0,
      total = 0;
    for (let i = 3; i < ref.length - 3; i++) {
      const r = delta(ref, i),
        u = delta(user, i);
      dot += r * u;
      rr += r * r;
      uu += u * u;
      if (ref[i] !== null) {
        total++;
        if (user[i] !== null) both++;
      }
    }
    const corr = rr > 0 && uu > 0 ? dot / Math.sqrt(rr * uu) : 0;
    const value = corr + (0.2 * both) / Math.max(1, total) - Math.abs(k) * 1e-7;
    if (value > best) {
      best = value;
      lag = k * hop;
    }
  }
  return lag;
}
export function onsets(xs: (number | null)[], hop: number) {
  const result: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === null) continue;
    const prev = xs[Math.max(0, i - 1)];
    if (
      i === 0 ||
      prev === null ||
      (Math.abs(xs[i]! - prev!) > SCORING.onsetJump &&
        i * hop - last > SCORING.onsetDebounce)
    ) {
      result.push(i * hop);
      last = i * hop;
    }
  }
  return result;
}
// Banded DTW on pitch contours after local key removal. 20 ms grid bounds CPU/memory.
export function rhythmOffsets(
  ref: (number | null)[],
  user: (number | null)[],
  shifts: number[],
  hop: number,
) {
  const stride = Math.max(1, Math.round(0.02 / hop)),
    dt = hop * stride;
  const r = ref.filter((_, i) => i % stride === 0),
    u = user.filter((_, i) => i % stride === 0),
    s = shifts.filter((_, i) => i % stride === 0);
  const n = r.length,
    band = Math.ceil(SCORING.dtwBand / dt),
    width = 2 * band + 1;
  const back = new Uint8Array(n * width);
  let prev = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n).fill(Infinity);
    for (let j = Math.max(0, i - band); j <= Math.min(n - 1, i + band); j++) {
      const cost =
        r[i] === null && u[j] === null
          ? 0
          : r[i] === null || u[j] === null
            ? 1.5
            : Math.min(3, Math.abs(u[j]! - s[i] - r[i]!));
      let v = i === 0 && j === 0 ? 0 : i > 0 && j > 0 ? prev[j - 1] : Infinity,
        dir = 1;
      if (i > 0 && prev[j] + 0.045 < v) {
        v = prev[j] + 0.045;
        dir = 2;
      }
      if (j > 0 && row[j - 1] + 0.045 < v) {
        v = row[j - 1] + 0.045;
        dir = 3;
      }
      row[j] = cost + v;
      back[i * width + j - i + band] = dir;
    }
    prev = row;
  }
  const map: number[][] = Array.from({ length: n }, () => []);
  let i = n - 1,
    j = n - 1;
  while (i >= 0 && j >= 0) {
    map[i].push(j * dt);
    if (i === 0 && j === 0) break;
    const dir = back[i * width + j - i + band];
    if (dir === 1) {
      i--;
      j--;
    } else if (dir === 2) i--;
    else if (dir === 3) j--;
    else break;
  }
  const starts = onsets(ref, hop),
    ustarts = onsets(user, hop);
  return starts.map((t) => {
    const idx = Math.min(n - 1, Math.round(t / dt));
    const mapped = map[idx].length ? median(map[idx]) : t;
    const candidates = ustarts.filter(
      (x) => Math.abs(x - t) <= SCORING.dtwBand && Math.abs(x - mapped) < 0.16,
    );
    const selected = candidates.sort(
      (a, b) => Math.abs(a - mapped) - Math.abs(b - mapped),
    )[0];
    return {
      t,
      offset: selected === undefined ? SCORING.dtwBand : selected - t,
    };
  });
}
