import { expect, it } from "vitest";
import { contourDrawable, contourRuns, smoothContour } from "../src/lib/ui/cover-contour";

it("короткие паузы перекрываются, длинные остаются", () => {
  const c = [60, null, 62, 63, null, null, null, null, 64];
  const s = smoothContour(c);
  expect(s[1]).not.toBeNull();
  expect(s.slice(4, 8)).toEqual([null, null, null, null]);
  expect(contourRuns(s)).toBe(2);
});

it("рваный контур не рисуется (обложка с волнами), ровный — рисуется", () => {
  const ragged = Array.from({ length: 80 }, (_, i) => (i % 6 < 2 ? 60 + (i % 3) : null));
  expect(contourDrawable(smoothContour(ragged))).toBe(false);
  const smooth = Array.from({ length: 80 }, (_, i) => (i > 70 ? null : 60 + Math.sin(i / 6) * 3));
  expect(contourDrawable(smoothContour(smooth))).toBe(true);
});
