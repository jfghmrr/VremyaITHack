import { describe, it, expect } from "vitest";
import {
  canonicalCurve,
  encodeChallenge,
  decodeChallenge,
} from "../src/challenge/codec";
import { curve, testSong } from "../tools/scenarios";
import { scorePerformance } from "../src/scoring";
const frames = canonicalCurve(
  curve((m) => m - 7),
  testSong.duration_s,
);
const challenge = {
  v: 1 as const,
  songId: "ode",
  name: "Саша 🎤",
  shift: 5,
  score: 100,
  curve: frames,
};
describe("URL challenge", () => {
  it("round-trips rests, deltas, Unicode and 0.1-semitone quantization", () =>
    expect(decodeChallenge(encodeChallenge(challenge))).toEqual(challenge));
  it("fits a 30-second pitch contour under 4 KiB", () => {
    const f = Array.from({ length: 600 }, (_, i) => ({
      t: i * 0.05,
      midi:
        i % 39 === 0
          ? null
          : 64 + 4 * Math.sin(i * 0.26) + 0.6 * Math.sin(i * 1.73),
    }));
    expect(encodeChallenge({ ...challenge, curve: f }).length).toBeLessThan(
      4096,
    );
  });
  it("rejects malformed payloads", () => {
    for (const hash of [
      "#x=hi",
      "#echo=%",
      "#echo=hello",
      "#echo=" + "a".repeat(9000),
    ])
      expect(() => decodeChallenge(hash)).toThrow();
  });
  it("empty link is a solo session", () =>
    expect(decodeChallenge("")).toBeNull());
  it("preserves the canonical score exactly", () => {
    const decoded = decodeChallenge(encodeChallenge(challenge))!;
    expect(scorePerformance(decoded.curve, testSong)).toEqual(
      scorePerformance(frames, testSong),
    );
  });
});
