import { describe, it, expect } from "vitest";
import { createPitchTracker } from "../src/audio/pitch";
describe("pitch capture", () => {
  it("finds A4 in a sine window", () => {
    const track = createPitchTracker(48000);
    const data = Float32Array.from(
      { length: 2048 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000),
    );
    expect(track(data).midi).toBeCloseTo(69, 1);
  });
  it("rejects silence", () =>
    expect(createPitchTracker(48000)(new Float32Array(2048)).midi).toBeNull());
});
