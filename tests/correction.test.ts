import { it, expect } from "vitest";
import { scorePerformance } from "../src/scoring";
import { correctionCurve } from "../src/audio/correction";
import { testSong, curve } from "../tools/scenarios";
it("correction targets the singer register, not the original key", () => {
  const frames = curve((m) => m - 7);
  const result = scorePerformance(frames, testSong);
  const points = correctionCurve(frames, testSong, result);
  expect(
    points
      .filter((p) => p.pitch !== null)
      .every((p) => Math.abs(p.pitch!) < 0.01),
  ).toBe(true);
  expect(points.find((p) => p.target !== null)?.target).toBe(53);
});
it("does not invent correction for unvoiced frames", () => {
  const frames = curve().map((f) => ({ ...f, midi: null }));
  expect(
    correctionCurve(frames, testSong, scorePerformance(frames, testSong)).every(
      (p) => p.pitch === null,
    ),
  ).toBe(true);
});
