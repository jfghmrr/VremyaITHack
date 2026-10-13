import type { PitchFrame, Song } from "../src/types";
export const testSong: Song = {
  id: "test",
  title: "Test",
  artist: "",
  hop_ms: 10,
  duration_s: 12,
  f0_midi: Array.from({ length: 1200 }, (_, i) =>
    i % 400 < 40
      ? null
      : ([60, 62, 64, 65, 67, 64][Math.floor(((i % 400) - 40) / 60)] ?? 62),
  ),
  phrases: [
    { start_s: 0.4, end_s: 4 },
    { start_s: 4.4, end_s: 8 },
    { start_s: 8.4, end_s: 12 },
  ],
  lyrics: [],
  backing: "",
};
export function curve(
  transform: (m: number, t: number) => number = (m) => m,
  delay = 0,
): PitchFrame[] {
  return testSong.f0_midi.map((m, i) => ({
    t: i * 0.01 + delay,
    midi: m === null ? null : transform(m, i * 0.01),
  }));
}
let seed = 37;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
export function scenarios() {
  seed = 37;
  return {
    Идеально: curve(),
    "+5 полутонов": curve((m) => m + 5),
    "−7 полутонов": curve((m) => m - 7),
    "Фальшивое пение": curve(
      (_m, t) => 60 + 7 * Math.sin(t * 8) + random() * 10 - 5,
    ),
    Тишина: curve().map((f) => ({ ...f, midi: null })),
    "Задержка 200 мс": curve((m) => m, 0.2),
    "Вибрато ±60 центов": curve(
      (m, t) => m + 0.6 * Math.sin(2 * Math.PI * 5.5 * t),
    ),
    "Смена тональности": curve((m, t) => m + (t < 4 ? 0 : t < 8 ? 3 : -2)),
    "Одна нота": curve(() => 64),
  };
}
