// Генерирует эталонные примеры скоринга из прежней TypeScript-реализации.
// Прежний код — тег legacy-react-fastify; порядок запуска в tools/fixtures/README.md.
// Выход: fixtures/scoring/*.json. Нечисловые значения (NaN, ±Infinity) пишутся строками.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scorePerformance } from "../../legacy/src/scoring/index.ts";
import { canonicalCurve } from "../../legacy/src/challenge/codec.ts";
import { correctionCurve } from "../../legacy/src/audio/correction.ts";
import { testSong } from "../../legacy/tools/scenarios.ts";
import type { PitchFrame, Song } from "../../legacy/src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "fixtures/scoring");
mkdirSync(out, { recursive: true });

const songs: Record<string, Song> = {
  test: testSong,
  ode: JSON.parse(readFileSync(join(root, "legacy/public/songs/ode/reference.json"), "utf8")),
  star: JSON.parse(readFileSync(join(root, "legacy/public/songs/star/reference.json"), "utf8")),
};

let seed = 0;
const rng = (s: number) => {
  seed = s >>> 0;
};
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function sing(
  song: Song,
  transform: (m: number, t: number) => number | null = (m) => m,
  delay = 0,
): PitchFrame[] {
  const hop = song.hop_ms / 1000;
  return song.f0_midi.map((m, i) => ({
    t: i * hop + delay,
    midi: m === null ? null : transform(m, i * hop),
  }));
}

// Локальный сдвиг по времени отдельных отрезков внутри фраз: общая задержка остаётся нулевой.
function localShift(song: Song, d: number, from: number, to: number) {
  const hop = song.hop_ms / 1000;
  return song.f0_midi.map((_, i) => {
    const t = i * hop;
    const src = t >= from && t < to ? Math.round((t - d) / hop) : i;
    const m = song.f0_midi[Math.max(0, Math.min(song.f0_midi.length - 1, src))];
    return { t, midi: m };
  });
}

function dropout(frames: PitchFrame[], p: number, s: number) {
  rng(s);
  return frames.map((f) => (random() < p ? { ...f, midi: null } : f));
}

// Ошибка на каждой третьей ноте: смещение, которое не поглощается локальной тональностью.
function noteError(song: Song, e: number) {
  let note = -1,
    prev: number | null = null;
  return sing(song).map((f, i) => {
    const r = song.f0_midi[i];
    if (r !== prev) {
      if (r !== null) note++;
      prev = r;
    }
    return r === null ? f : { ...f, midi: note % 3 === 2 ? r + e : r };
  });
}

interface Case {
  name: string;
  song: string;
  frames: (PitchFrame | { t: number | string; midi: number | string | null })[];
}
const cases: Case[] = [];
const add = (name: string, song: string, frames: Case["frames"]) =>
  cases.push({ name, song, frames });

// Базовые сценарии старой реализации (tools/scenarios.ts) с тем же генератором шума.
rng(37);
const t = songs.test;
add("perfect", "test", sing(t));
add("transpose +5", "test", sing(t, (m) => m + 5));
add("transpose -7", "test", sing(t, (m) => m - 7));
add("wrong noisy", "test", sing(t, (_m, x) => 60 + 7 * Math.sin(x * 8) + random() * 10 - 5));
add("silence", "test", sing(t, () => null));
add("delay 200 ms", "test", sing(t, (m) => m, 0.2));
add("vibrato 60 cents", "test", sing(t, (m, x) => m + 0.6 * Math.sin(2 * Math.PI * 5.5 * x)));
add("key drift", "test", sing(t, (m, x) => m + (x < 4 ? 0 : x < 8 ? 3 : -2)));
add("constant note", "test", sing(t, () => 64));

// Регистр и задержка.
add("octave -12", "test", sing(t, (m) => m - 12));
add("octave +12", "test", sing(t, (m) => m + 12));
add("transpose -7 with 120 ms delay", "test", sing(t, (m) => m - 7, 0.12));
add("negative delay -150 ms", "test", sing(t, (m) => m, -0.15));
add("delay 290 ms (inside search)", "test", sing(t, (m) => m, 0.29));
add("delay 310 ms (outside search)", "test", sing(t, (m) => m, 0.31));
add("delay 450 ms", "test", sing(t, (m) => m, 0.45));

// Вибрато и дрейф.
add("vibrato 100 cents 5.5 Hz", "test", sing(t, (m, x) => m + 1.0 * Math.sin(2 * Math.PI * 5.5 * x)));
add("vibrato 150 cents 3 Hz", "test", sing(t, (m, x) => m + 1.5 * Math.sin(2 * Math.PI * 3 * x)));
add("slow drift +1.5 over song", "test", sing(t, (m, x) => m + (1.5 * x) / 12));
add("key drift +5 then -7", "test", sing(t, (m, x) => m + (x < 4 ? 5 : x < 8 ? -7 : 0)));
add("unstable 90 cents 1.3 Hz", "test", sing(t, (m, x) => m + 0.9 * Math.sin(2 * Math.PI * 1.3 * x)));

// Пороги интервалов (30 и 150 центов).
for (const e of [0.25, 0.3, 0.35, 1.4, 1.5, 1.6]) add(`note error ${e}`, "test", noteError(t, e));
// Пороги ритма (80 и 300 мс) на отрезках внутри фраз.
for (const d of [0.07, 0.08, 0.09, 0.15, 0.29, 0.3, 0.31])
  add(`local timing ${d}`, "test", localShift(t, d, 5, 7.5));
add("local timing 240 ms (legacy test)", "test", sing(t).map((x) => ({ ...x, t: x.t + (x.t > 5 && x.t < 7 ? 0.24 : 0) })));
// Покрытие около 30%.
for (const p of [0.65, 0.69, 0.7, 0.71, 0.75]) add(`dropout ${p}`, "test", dropout(sing(t), p, 101));
// Постоянная нота около порога разброса 0.18.
for (const a of [0.2, 0.25, 0.26, 0.3]) add(`near-constant ${a}`, "test", sing(t, (_m, x) => 64 + a * Math.sin(2 * Math.PI * 2 * x)));
add("constant note on 20 frames", "test", sing(t).map((f, i) => ({ ...f, midi: i < 61 && f.midi !== null ? 64 : null })));

// Пропущенные кадры, дубликаты, порядок, нечисловые значения.
add("gaps 100 ms every second", "test", sing(t).filter((f) => (f.t as number) % 1 >= 0.1));
add("every other frame", "test", sing(t).filter((_, i) => i % 2 === 0));
add("every fourth frame", "test", sing(t).filter((_, i) => i % 4 === 0));
rng(7);
add("timestamp jitter 4 ms", "test", sing(t, (m) => m - 3).map((f) => ({ ...f, t: (f.t as number) + (random() - 0.5) * 0.008 })));
add("duplicate timestamps", "test", sing(t, (m) => m + 2).flatMap((f) => [f, { ...f, midi: f.midi === null ? null : f.midi + 0.4 }]));
rng(11);
add("shuffled order", "test", sing(t, (m) => m + 1).map((f) => ({ f, k: random() })).sort((a, b) => a.k - b.k).map((x) => x.f));
add("non-finite values", "test", sing(t).map((f, i) => i % 50 === 7 ? { t: f.t, midi: "NaN" } : i % 50 === 9 ? { t: f.t, midi: "Infinity" } : i % 97 === 3 ? { t: "NaN", midi: f.midi } : f));
add("frames outside range", "test", [
  ...Array.from({ length: 50 }, (_, i) => ({ t: -0.5 + i * 0.01, midi: 70 })),
  ...sing(t),
  ...Array.from({ length: 50 }, (_, i) => ({ t: 12.01 + i * 0.01, midi: 50 })),
]);
add("empty frames", "test", []);
add("single frame", "test", [{ t: 1, midi: 60 }]);
// Одинаковые потери в повторяющихся фразах: проверка устойчивой сортировки моментов.
add("equal losses across phrases", "test", sing(t, (m, x) => { const p = (x * 100) % 400; return p >= 160 && p < 220 ? m + 0.8 : m; }));
add("equal losses missing", "test", sing(t, (m, x) => { const p = (x * 100) % 400; return p >= 100 && p < 330 ? null : m; }));

// Случайные исполнения (детерминированные).
for (let k = 0; k < 24; k++) {
  rng(Math.imul(1000 + k, 2654435761));
  random();
  const shift = Math.round(random() * 24 - 12),
    delay = Math.round((random() * 0.5 - 0.25) * 100) / 100,
    noise = random() * 1.2,
    drop = random() * 0.5,
    vib = random() * 1.2,
    rate = 3 + random() * 4;
  const song = k % 3 === 0 ? "test" : k % 3 === 1 ? "ode" : "star";
  const frames = sing(songs[song], (m, x) => m + shift + vib * Math.sin(2 * Math.PI * rate * x) + (random() - 0.5) * noise, delay);
  add(`fuzz ${k}`, song, dropout(frames, drop, 2000 + k));
}

// Настоящие демо-эталоны.
for (const id of ["ode", "star"]) {
  const s = songs[id];
  add(`${id} perfect -5`, id, sing(s, (m) => m - 5));
  add(`${id} +3 delay 120 ms`, id, sing(s, (m) => m + 3, 0.12));
  add(`${id} silence`, id, sing(s, () => null));
  add(`${id} first phrase only`, id, sing(s, (m, x) => (x < s.phrases[0].end_s ? m : null)));
  add(`${id} constant note`, id, sing(s, () => 62));
  rng(id === "ode" ? 501 : 502);
  add(`${id} amateur`, id, sing(s, (m, x) => m - 2 + 0.7 * Math.sin(2 * Math.PI * 0.4 * x) + (random() - 0.5) * 0.8, 0.05));
}

const parse = (v: number | string | null) => (typeof v === "string" ? Number(v) : v);
const real = (frames: Case["frames"]): PitchFrame[] =>
  frames.map((f) => ({ t: parse(f.t) as number, midi: parse(f.midi) }));
const encode = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "number" && !Number.isFinite(x) ? String(x) : x,
  );

const scoreCases = cases.map((c) => ({
  ...c,
  expected: scorePerformance(real(c.frames), songs[c.song]),
}));

// Путь дуэли: каноническая сетка 50 мс и 0.1 полутона, затем та же функция оценки.
const duel = cases
  .filter((c) => !c.name.startsWith("fuzz") || Number(c.name.slice(5)) < 12)
  .map((c) => {
    const curve = canonicalCurve(real(c.frames), songs[c.song].duration_s);
    return { name: c.name, song: c.song, frames: c.frames, curve, expected: scorePerformance(curve, songs[c.song]) };
  });

// Исход пары по правилу старой дуэли: ничья при равенстве с точностью 0.1.
const outcome = (a: number, b: number) =>
  Math.round(a * 10) === Math.round(b * 10) ? "draw" : a > b ? "win" : "loss";
const pairs: { a: string; b: string; song: string; outcome: string }[] = [];
for (const a of duel)
  for (const b of duel)
    if (a !== b && a.song === b.song && pairs.length < 400)
      pairs.push({ a: a.name, b: b.name, song: a.song, outcome: outcome(a.expected.score, b.expected.score) });

const correction = cases
  .filter((c) => ["transpose -7", "perfect", "vibrato 60 cents", "silence", "ode amateur", "fuzz 4"].includes(c.name))
  .map((c) => {
    const frames = real(c.frames);
    return { name: c.name, song: c.song, frames: c.frames, expected: correctionCurve(frames, songs[c.song], scorePerformance(frames, songs[c.song])) };
  });

writeFileSync(join(out, "songs.json"), encode(songs));
writeFileSync(join(out, "score.json"), encode(scoreCases));
writeFileSync(join(out, "duel.json"), encode(duel));
writeFileSync(join(out, "pairs.json"), encode(pairs));
writeFileSync(join(out, "correction.json"), encode(correction));
console.log(`score ${scoreCases.length}, duel ${duel.length}, pairs ${pairs.length}, correction ${correction.length}`);
