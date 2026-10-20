// Обводка ломаной линии голоса (PianoRoll, ResultTrace): подряд идущие отрезки одного стиля
// обводятся одной линией. Отдельные полупрозрачные отрезки с круглыми концами накладывались на
// стыках и давали «бусины».

type Ctx = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "stroke">;

/**
 * Точки 0…n−1 с координатами x(k), y(k). newPart(k) — с точки k начинается новая часть (разрыв).
 * styleOf(k) — стиль отрезка (k−1 → k), целое число; apply(style, x0) задаёт стиль перед новой
 * линией (x0 — начало линии, для смещения штриха).
 */
export function strokeRuns(
  ctx: Ctx,
  n: number,
  x: (k: number) => number,
  y: (k: number) => number,
  newPart: (k: number) => boolean,
  styleOf: (k: number) => number,
  apply: (style: number, x0: number) => void,
) {
  let style = -1;
  for (let k = 1; k < n; k++) {
    if (newPart(k)) {
      if (style >= 0) ctx.stroke();
      style = -1;
      continue;
    }
    const s = styleOf(k);
    if (s !== style) {
      if (style >= 0) ctx.stroke();
      style = s;
      apply(s, x(k - 1));
      ctx.beginPath();
      ctx.moveTo(x(k - 1), y(k - 1));
    }
    ctx.lineTo(x(k), y(k));
  }
  if (style >= 0) ctx.stroke();
}
