import { describe, it, expect } from "vitest";
import { scorePerformance } from "../src/scoring";
import { scenarios, testSong, curve } from "../tools/scenarios";
const all = scenarios();
const result = (key: keyof typeof all) => scorePerformance(all[key], testSong);
describe("deterministic key-invariant scoring", () => {
  for (const key of ["Идеально", "+5 полутонов", "−7 полутонов"] as const)
    it(key, () => expect(result(key).score).toBeGreaterThanOrEqual(95));
  it("penalizes noisy wrong singing", () =>
    expect(result("Фальшивое пение").score).toBeLessThan(50));
  it("silence", () => expect(result("Тишина").score).toBeLessThanOrEqual(30));
  it("removes constant 200 ms latency", () => {
    const r = result("Задержка 200 мс");
    expect(r.score).toBeGreaterThanOrEqual(result("Идеально").score - 5);
    expect(r.lag).toBeCloseTo(0.2, 2);
  });
  it("preserves natural vibrato", () =>
    expect(result("Вибрато ±60 центов").score).toBeGreaterThanOrEqual(
      result("Идеально").score - 5,
    ));
  it("assigns phrase key drift to stability", () => {
    const r = result("Смена тональности");
    expect(r.axes.intervals).toBeGreaterThan(0.95);
    expect(r.axes.stability).toBeLessThan(0.5);
  });
  it("rejects a constant note", () =>
    expect(result("Одна нота").score).toBeLessThanOrEqual(30));
  it("octave register does not change score", () =>
    expect(
      scorePerformance(
        curve((m) => m - 12),
        testSong,
      ).score,
    ).toBeGreaterThanOrEqual(95));
  it("local timing errors remain after latency removal", () => {
    const f = curve().map((x) => ({
      ...x,
      t: x.t + (x.t > 5 && x.t < 7 ? 0.24 : 0),
    }));
    expect(
      scorePerformance(f, testSong).noteOffsets.some(
        (n) => Math.abs(n.offset) > 0.15,
      ),
    ).toBe(true);
  });
  it("is deterministic", () =>
    expect(result("Фальшивое пение")).toEqual(result("Фальшивое пение")));
});

it("measures stability on pYIN-like floating reference pitches", () => {
  const floating = {
    ...testSong,
    f0_midi: testSong.f0_midi.map((m, i) =>
      m === null ? null : m + 0.025 * Math.sin(i * 0.71),
    ),
  };
  const unstable = curve((m, t) => m + 0.9 * Math.sin(2 * Math.PI * 1.3 * t));
  expect(scorePerformance(unstable, floating).axes.stability).toBeLessThan(0.8);
});
