// Контур мелодии на обложке: короткие паузы (до 3 точек) перекрываются, линия сглаживается.
// Если после этого мелодия всё ещё рвётся на много коротких кусков, обложка рисует волны:
// обрывки линии выглядели как испорченная надпись (QA L18).

/** Перекрывает пропуски до maxGap точек линейной интерполяцией и сглаживает по трём соседям. */
export function smoothContour(contour: (number | null)[], maxGap = 3): (number | null)[] {
  const out = contour.slice();
  for (let i = 0; i < out.length; ) {
    if (out[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const a = out[i - 1];
    const b = out[j];
    if (i > 0 && j < out.length && a != null && b != null && j - i <= maxGap)
      for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return out.map((m, k) => {
    if (m === null) return null;
    const near = [out[k - 1], m, out[k + 1]].filter((x): x is number => x != null);
    return near.reduce((s, x) => s + x, 0) / near.length;
  });
}

/** Кусков линии после сглаживания (непрерывных участков с голосом). */
export function contourRuns(contour: (number | null)[]): number {
  let runs = 0;
  contour.forEach((m, i) => {
    if (m !== null && (i === 0 || contour[i - 1] === null)) runs++;
  });
  return runs;
}

/** Контур годится для обложки: не больше maxRuns кусков и голос хотя бы на трети точек. */
export function contourDrawable(contour: (number | null)[], maxRuns = 6): boolean {
  const voiced = contour.filter((m) => m !== null).length;
  return voiced >= contour.length / 3 && contourRuns(contour) <= maxRuns;
}
