// Паритет WASM-сборки scoring-core с прежней TypeScript-реализацией.
// Эталоны: fixtures/scoring (см. tools/fixtures/generate.ts). Допуск нулевой, как и в native.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalCurve,
  correctionCurve,
  initWasmSync,
  outcome,
  scorePerformance,
} from "../src/lib/scoring/core";
import type { PitchFrame, Song } from "../src/lib/scoring/types";

const dir = new URL("../../fixtures/scoring/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const num = (v: unknown) => (typeof v === "string" ? Number(v) : v);
const frames = (raw: { t: unknown; midi: unknown }[]) =>
  raw.map((f) => ({ t: num(f.t), midi: num(f.midi) }) as PitchFrame);
const withoutRaw = ({ rawScore: _, ...rest }: { rawScore: number }) => rest;

let songs: Record<string, Song>;
beforeAll(() => {
  initWasmSync(readFileSync(new URL("../src/lib/wasm/scoring_bg.wasm", import.meta.url)));
  songs = load("songs.json");
});

// Тяжёлые детерминированные циклы по эталонам: на медленных CI и серверах (x86_64 под нагрузкой)
// они не укладываются в 5 с по умолчанию, поэтому у этих тестов явный таймаут.
const HEAVY_TIMEOUT_MS = 120_000;

describe("WASM = legacy TypeScript", () => {
  it("score cases", () => {
    for (const c of load("score.json")) {
      const got = scorePerformance(frames(c.frames), songs[c.song]);
      expect(withoutRaw(got), c.name).toStrictEqual(c.expected);
    }
  }, HEAVY_TIMEOUT_MS);
  it("duel path on the 50 ms grid", () => {
    for (const c of load("duel.json")) {
      const curve = canonicalCurve(frames(c.frames), songs[c.song].duration_s);
      expect(curve, c.name).toStrictEqual(c.curve);
      expect(withoutRaw(scorePerformance(curve, songs[c.song])), c.name).toStrictEqual(c.expected);
    }
  }, HEAVY_TIMEOUT_MS);
  it("match outcomes", () => {
    const scores = new Map<string, number>(
      load("duel.json").map((c: { name: string; song: string; curve: PitchFrame[] }) => [
        c.name,
        scorePerformance(c.curve, songs[c.song]).score,
      ]),
    );
    for (const p of load("pairs.json"))
      expect(outcome(scores.get(p.a)!, scores.get(p.b)!), `${p.a} vs ${p.b}`).toBe(p.outcome);
  }, HEAVY_TIMEOUT_MS);
  it("correction curves", () => {
    for (const c of load("correction.json")) {
      const f = frames(c.frames);
      const result = scorePerformance(f, songs[c.song]);
      expect(correctionCurve(f, songs[c.song], result), c.name).toStrictEqual(c.expected);
    }
  });
});
