// Слова на сцене дуэли: текущая и следующая строка по общему времени песни.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lineAt, parseWordTiming } from "../src/lib/lyrics";
import type { Song } from "../src/lib/scoring/types";

const lyrics = [
  { t: 1.4, text: "a" },
  { t: 4.0, text: "b" },
  { t: 7.5, text: "c" },
];

it("строка выбирается по времени: до первой — −1, на границе — новая строка", () => {
  expect(lineAt(lyrics, -1)).toBe(-1);
  expect(lineAt(lyrics, 1.39)).toBe(-1);
  expect(lineAt(lyrics, 1.4)).toBe(0);
  expect(lineAt(lyrics, 3.99)).toBe(0);
  expect(lineAt(lyrics, 4)).toBe(1);
  expect(lineAt(lyrics, 100)).toBe(2);
  expect(lineAt([], 5)).toBe(-1);
});

it("для каждой песни каталога строка дуэли совпадает со строкой одиночной сцены, а разметка слов читается", () => {
  const songs = new URL("../static/songs/", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", songs), "utf8")) as { id: string; wordTiming?: string }[];
  for (const entry of index) {
    const song: Song = JSON.parse(readFileSync(new URL(`${entry.id}/reference.json`, songs), "utf8"));
    expect(song.lyrics.length, entry.id).toBeGreaterThan(0);
    for (let t = -0.5; t < song.duration_s; t += 0.25) {
      // Та же формула, что у листа одиночной сцены (sing/[id]: последняя строка с l.t <= clock).
      let solo = -1;
      song.lyrics.forEach((l, k) => { if (l.t <= t) solo = k; });
      expect(lineAt(song.lyrics, t), `${entry.id} @ ${t}`).toBe(t < 0 ? -1 : solo);
    }
    if (entry.wordTiming) {
      const raw = JSON.parse(readFileSync(new URL(`${entry.id}/${entry.wordTiming}`, songs), "utf8"));
      expect(() => parseWordTiming(raw, song), entry.id).not.toThrow();
    }
  }
});
