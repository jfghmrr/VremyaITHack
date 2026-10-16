// @ts-nocheck — вспомогательный замер, не часть приложения.
// Время подготовки и оценки WASM в Node: node tests/wasm-bench.mjs
import { readFileSync } from "node:fs";
const t0 = performance.now();
const wasm = await import("../src/lib/wasm/scoring.js");
const bytes = readFileSync(new URL("../src/lib/wasm/scoring_bg.wasm", import.meta.url));
wasm.initSync({ module: bytes });
const init = performance.now() - t0;
const song = JSON.parse(readFileSync(new URL("../static/songs/ode/reference.json", import.meta.url), "utf8"));
const songJson = JSON.stringify({ hop_ms: song.hop_ms, duration_s: song.duration_s, f0_midi: song.f0_midi, phrases: song.phrases });
console.log(`WASM: ${(bytes.length / 1024).toFixed(0)} КиБ, инициализация ${init.toFixed(1)} мс`);
for (const [label, hop] of [["10 мс, 2000 кадров", 0.01], ["50 мс, 400 точек", 0.05]]) {
  const frames = Array.from({ length: Math.round(song.duration_s / hop) }, (_, i) => {
    const t = i * hop;
    const m = song.f0_midi[Math.min(song.f0_midi.length - 1, Math.floor(t * 100))];
    return { t, midi: m === null ? null : m - 5 + 0.3 * Math.sin(t * 7) };
  });
  const json = JSON.stringify(frames);
  wasm.score(json, songJson);
  const runs = 30;
  const s = performance.now();
  for (let i = 0; i < runs; i++) wasm.score(json, songJson);
  console.log(`WASM ${label}: ${((performance.now() - s) / runs).toFixed(1)} мс на оценку (с разбором JSON)`);
}
