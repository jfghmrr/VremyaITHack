// Каждый эталон каталога корректен: проходит те же проверки, что сервер и клиент,
// а точное пение в другой тональности получает высокий балл, тишина — низкий.
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { initWasmSync, scorePerformance } from "../src/lib/scoring/core";
import type { Song } from "../src/lib/scoring/types";
import { asset, ownTrack } from "../src/lib/catalog";

const dir = new URL("../static/songs/", import.meta.url);
const index: { id: string; duration_s: number; preview?: string }[] = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));

beforeAll(() => initWasmSync(readFileSync(new URL("../src/lib/wasm/scoring_bg.wasm", import.meta.url))));

it("файлы своего трека (my-<uuid>) берутся из /api/tracks, песни каталога — из /songs", () => {
  const uuid = "0b9f7c1e-2a4d-4e8b-9c3f-5d6e7f809a1b";
  expect(ownTrack(`my-${uuid}`)).toBe(uuid);
  expect(ownTrack("cn-earth")).toBeNull();
  expect(asset(`my-${uuid}`, "instrumental.mp3")).toBe(`/api/tracks/${uuid}/files/instrumental.mp3`);
  expect(asset("cn-earth", "guide.mp3")).toBe("/songs/cn-earth/guide.mp3");
});

it("в каталоге много песен с уникальными id", () => {
  expect(index.length).toBeGreaterThanOrEqual(20);
  expect(new Set(index.map((s) => s.id)).size).toBe(index.length);
});

for (const info of index) {
  it(`эталон ${info.id}`, () => {
    const song: Song = JSON.parse(readFileSync(new URL(`${info.id}/reference.json`, dir), "utf8"));
    expect(song.id).toBe(info.id);
    expect(song.hop_ms).toBe(10);
    expect(song.duration_s).toBeGreaterThan(0);
    expect(song.duration_s).toBeLessThanOrEqual(60);
    expect(song.duration_s).toBe(info.duration_s);
    expect(song.f0_midi.length).toBeLessThanOrEqual(6001);
    expect(song.phrases.length).toBeGreaterThan(0);
    const frames = song.f0_midi.map((m, i) => ({ t: i * 0.01, midi: m === null ? null : m - 3 }));
    expect(scorePerformance(frames, song).score).toBeGreaterThanOrEqual(95);
    const silent = frames.map((f) => ({ ...f, midi: null }));
    expect(scorePerformance(silent, song).score).toBeLessThanOrEqual(30);
    for (const file of [song.backing, info.preview ?? "guide.wav"]) expect(readFileSync(new URL(`${info.id}/${file}`, dir)).length).toBeGreaterThan(1000);
  });
}
