export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((a, b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export const clamp = (x: number, lo = 0, hi = 1) =>
  Math.max(lo, Math.min(hi, x));
export const wrap = (x: number) => ((((x + 6) % 12) + 12) % 12) - 6;
export const quality = (e: number, good: number, bad: number) =>
  clamp(1 - (Math.abs(e) - good) / (bad - good));
export function circularMedian(xs: number[]) {
  if (!xs.length) return 0;
  let best = 0,
    cost = Infinity;
  // 0.1 semitone grid, then refine with the median of unwrapped observations.
  for (let q = -60; q < 60; q++) {
    const s = q / 10;
    const c = xs.reduce((sum, x) => sum + Math.abs(wrap(x - s)), 0);
    if (c < cost) {
      cost = c;
      best = s;
    }
  }
  return wrap(best + median(xs.map((x) => wrap(x - best))));
}
export function smooth(values: (number | null)[], radius: number) {
  return values.map((v, i) => {
    if (v === null) return null;
    const xs: number[] = [];
    for (
      let j = Math.max(0, i - radius);
      j <= Math.min(values.length - 1, i + radius);
      j++
    )
      if (values[j] !== null) xs.push(values[j]!);
    return mean(xs);
  });
}
