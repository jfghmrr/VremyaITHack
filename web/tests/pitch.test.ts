// Детектор высоты (pitch.ts): анализ окна MPM в диапазоне голоса, решение о голосе с гистерезисом
// ясности, подтверждением начала ноты, поправкой октавной ошибки и центрированной медианой.
// Синтетические сигналы; замер на настоящем вокале каталога — в pitch-report.md.
import { PitchDetector } from "pitchy";
import { describe, expect, it } from "vitest";
import { AUDIO, createAnalyser, createPitchTracker, createVoicing, VOICING, type Decided } from "../src/lib/audio/pitch";

const RATE = 48_000;
const HOP = 480;
const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** Голосоподобный тон: гармоники 1/k, пауза в шуме — по желанию. Возвращает окна 2048 с шагом 10 мс. */
function voice(midis: number[], opts: { amp?: number; noise?: number[]; seed?: number } = {}) {
  const amp = opts.amp ?? 0.1;
  const r = rng(opts.seed ?? 3);
  const total = midis.length * HOP + 2048;
  const s = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const frame = Math.min(midis.length - 1, Math.max(0, Math.floor((i - 1024) / HOP)));
    phase += (2 * Math.PI * hzOf(midis[frame])) / RATE;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * phase) / k;
    s[i] = amp * v * 0.6 + (opts.noise?.[frame] ?? 0) * r();
  }
  return midis.map((_, k) => s.slice(k * HOP, k * HOP + 2048));
}

describe("анализ окна: MPM в диапазоне голоса", () => {
  const analyse = createAnalyser(AUDIO.window);
  for (const midi of [43, 50, 57, 64, 72, 81]) {
    it(`голосоподобный тон MIDI ${midi}: высота и ясность`, () => {
      const [w] = voice([midi]);
      const a = analyse(w, RATE);
      expect(69 + 12 * Math.log2(a.hz / 440)).toBeCloseTo(midi, 1);
      expect(a.clarity).toBeGreaterThan(0.9);
    });
  }

  it("тон выше 1100 Гц отбрасывается, а не попадает в диапазон октавой ниже", () => {
    const at = (hz: number) => {
      const [w] = voice([69 + 12 * Math.log2(hz / 440)]);
      const sine = Float32Array.from({ length: 2048 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * hz * i) / RATE));
      return [analyse(w, RATE).hz, analyse(sine, RATE).hz];
    };
    for (const hz of [1110, 1150, 1500]) expect(at(hz), `${hz} Гц`).toEqual([0, 0]);
    for (const got of at(1098)) expect(got).toBeCloseTo(1098, -1);
  });

  it("тишина и шум: высоты нет или ясность низкая", () => {
    expect(analyse(new Float32Array(2048), RATE).hz).toBe(0);
    const r = rng(11);
    const noise = Float32Array.from({ length: 2048 }, () => 0.05 * r());
    const a = analyse(noise, RATE);
    expect(a.hz === 0 || a.clarity < 0.5).toBe(true);
  });

  it("период ищется только в 65–1100 Гц: где pitchy уходит ниже 65 Гц, высота голоса остаётся", () => {
    // Тон 196 Гц (G3), зашумлённый так, что ложный максимум на длинном сдвиге у pitchy выше
    // максимума периода. Ищем такие окна среди зашумлённых вариантов и проверяем каждое.
    const pitchy = PitchDetector.forFloat32Array(2048);
    let cases = 0;
    for (let seed = 1; seed <= 200 && cases < 5; seed++) {
      const [w] = voice([55], { noise: [0.12], seed });
      const [hz] = pitchy.findPitch(w, RATE);
      if (hz >= AUDIO.minHz) continue;
      cases++;
      const a = analyse(w, RATE);
      expect(69 + 12 * Math.log2(a.hz / 440), `seed ${seed}`).toBeCloseTo(55, 0);
    }
    expect(cases, "pitchy действительно ошибается на части окон").toBeGreaterThan(0);
  });
});

/** Последовательность анализов окон (высота, ясность, громкость) через createVoicing с порогом gate. */
type In = { midi: number | null; clarity?: number; rms?: number };
function decide(frames: In[], gate = AUDIO.rms) {
  const v = createVoicing();
  const out: Decided[] = [];
  const all: In[] = [...frames, ...Array.from({ length: VOICING.delay }, () => ({ midi: null }))];
  all.forEach((f, i) => {
    const d = v.push({ hz: f.midi === null ? 0 : hzOf(f.midi), clarity: f.midi === null ? 0 : (f.clarity ?? 0.95), rms: f.rms ?? 0.05, time: i * 0.01 }, gate);
    if (d) out.push(d);
  });
  return out;
}
const note = (n: number, midi: number | null, clarity = 0.95, rms = 0.05) => Array.from({ length: n }, () => ({ midi, clarity, rms }));

describe("решение о голосе", () => {
  it("кадр решается с задержкой и возвращается со своим временем", () => {
    const out = decide(note(20, 60));
    expect(out).toHaveLength(20);
    out.forEach((f, i) => expect(f.time).toBeCloseTo(i * 0.01, 9));
  });

  it("короткий провал ясности внутри ноты (0.6) не рвёт линию; длинный — рвёт", () => {
    // Окно: hold кадров после ясного кадра и ещё delay кадров, если впереди снова ясный кадр.
    const short = VOICING.hold + VOICING.delay;
    const out = decide([...note(10, 60), ...note(short, 60.1, 0.6), ...note(10, 60)]);
    expect(out.every((f) => f.midi !== null)).toBe(true);
    const long = decide([...note(10, 60), ...note(short + 3, 60.1, 0.6), ...note(10, 60)]);
    expect(long.slice(10, 10 + short + 3).some((f) => f.midi === null)).toBe(true);
  });

  it("протяжная нота с ясностью 0.86–0.9 — голос целиком, как у прежнего детектора", () => {
    for (const clarity of [0.86, 0.87, 0.88, 0.89]) {
      const out = decide([...note(5, null), ...note(50, 60, clarity), ...note(5, null)]);
      expect(out.slice(5, 55).filter((f) => f.midi !== null).length, `ясность ${clarity}`).toBe(50);
    }
  });

  it("нота 0.88 после двух кадров начала 0.91 — голос целиком", () => {
    const out = decide([...note(5, null), ...note(2, 60, 0.91), ...note(50, 60, 0.88), ...note(5, null)]);
    expect(out.slice(5, 57).every((f) => f.midi !== null)).toBe(true);
  });

  it("с ясностью ниже порога начала нота не начинается", () => {
    const out = decide([...note(5, null), ...note(30, 60, 0.75), ...note(5, null)]);
    expect(out.every((f) => f.midi === null)).toBe(true);
  });

  it("неясный кадр далеко от текущей ноты — не продолжение", () => {
    const out = decide([...note(10, 60), ...note(1, 64, 0.6), ...note(10, null)]);
    expect(out[10].midi).toBeNull();
    expect(out.slice(0, 10).every((f) => f.midi !== null)).toBe(true);
  });

  it("ясный выброс далеко от ноты посреди ноты не рисует «иглу»; настоящая новая нота принимается", () => {
    const spike = decide([...note(10, 60), ...note(1, 50, 0.97), ...note(10, 60)]);
    expect(spike[10].midi).toBeNull();
    expect(spike.filter((f, i) => i !== 10).every((f) => f.midi !== null && Math.abs(f.midi - 60) < 0.01)).toBe(true);
    const leap = decide([...note(10, 60), ...note(10, 65)]);
    expect(leap.slice(10).every((f) => f.midi !== null && Math.abs(f.midi - 65) < 0.01)).toBe(true);
  });

  it("одиночный ясный всплеск не становится голосом", () => {
    const out = decide([...note(10, null), ...note(1, 62), ...note(10, null)]);
    expect(out.every((f) => f.midi === null)).toBe(true);
  });

  it("тише порога нота не начинается и не продолжается (порог level.ts без изменений)", () => {
    const quiet = decide(note(30, 60, 0.98, 0.006));
    expect(quiet.every((f) => f.midi === null)).toBe(true);
    // Громкая нота, затем тот же тон тише порога (подсказка из наушников): продолжения нет.
    const out = decide([...note(20, 57, 0.98, 0.05), ...note(20, 57, 0.98, 0.006)]);
    expect(out.slice(0, 20).every((f) => f.midi !== null)).toBe(true);
    expect(out.slice(20).every((f) => f.midi === null)).toBe(true);
  });

  it("неясный тон после ясной ноты не тянется дальше окна гистерезиса (2 с, ясность 0.6, выше порога)", () => {
    const out = decide([...note(20, 60), ...note(200, 60.2, 0.6)]);
    const tail = out.slice(20);
    const voiced = tail.filter((f) => f.midi !== null).length;
    expect(voiced).toBeLessThanOrEqual(VOICING.hold);
    expect(tail.slice(VOICING.hold).every((f) => f.midi === null)).toBe(true);
  });

  it("мелодия подсказки из наушников выше сниженного порога (0.002) не продолжает фразу после одной ясной ноты", () => {
    // Певец спел одну ясную ноту, дальше в микрофон слышна только подсказка: та же мелодия
    // ступенями по полутону, ясность 0.7, громкость 0.003 — выше порога 0.002 после замера.
    const leak = [60, 61, 62, 61, 60, 59, 60, 62].flatMap((m) => note(25, m, 0.7, 0.003));
    const out = decide([...note(20, 60, 0.95, 0.05), ...leak], 0.002);
    const carried = out.slice(20).filter((f) => f.midi !== null).length;
    expect(carried).toBeLessThanOrEqual(VOICING.hold);
  });

  it("ясный кадр впереди продлевает окно гистерезиса", () => {
    const out = decide([...note(10, 60), ...note(VOICING.hold + 2, 60, 0.6), ...note(1, 60), ...note(10, 60)]);
    expect(out.every((f) => f.midi !== null)).toBe(true);
  });

  it("опора — кадры текущей ноты: после скачка дальше 1,5 полутона неясные кадры продолжают новую ноту", () => {
    // Два ясных кадра новой ноты, затем неясный: среди последних пяти решённых кадров больше прежней ноты.
    const out = decide([...note(10, 60), ...note(2, 63), ...note(1, 63, 0.7), ...note(5, 63), ...note(5, null)]);
    expect(out.slice(10, 18).every((f) => f.midi !== null && Math.abs(f.midi - 63) < 0.01)).toBe(true);
  });

  it("скачок 60 → 72 с дрожанием от кадра к кадру — новая нота на 72, а не свёрнутая к 60", () => {
    const vib = Array.from({ length: 30 }, (_, i) => ({ midi: 72 + (i % 2 ? 0.55 : -0.55), clarity: 0.95, rms: 0.05 }));
    const out = decide([...note(20, 60), ...vib]);
    expect(out.slice(20).every((f) => f.midi !== null && Math.abs(f.midi - 72) < 1)).toBe(true);
  });

  it("скачок на октаву и сразу один пропущенный кадр: кадр скачка не уходит октавой ниже", () => {
    const out = decide([...note(20, 60), ...note(1, 72), ...note(1, null), ...note(30, 72)]);
    expect(out[20].midi === null || Math.abs(out[20].midi - 72) < 0.01).toBe(true);
    expect(out.slice(22).every((f) => f.midi !== null && Math.abs(f.midi - 72) < 0.01)).toBe(true);
  });

  it("октавная ошибка в кадре-двух возвращается к ноте", () => {
    const out = decide([...note(10, 60), ...note(2, 72), ...note(10, 60)]);
    expect(out.every((f) => f.midi !== null && Math.abs(f.midi - 60) < 0.01)).toBe(true);
    const down = decide([...note(10, 60), ...note(1, 48), ...note(10, 60)]);
    expect(down.every((f) => f.midi !== null && Math.abs(f.midi - 60) < 0.01)).toBe(true);
  });

  it("настоящий скачок на октаву держится и принимается", () => {
    const out = decide([...note(15, 60), ...note(20, 72)]);
    expect(out.slice(0, 15).every((f) => f.midi !== null && Math.abs(f.midi - 60) < 0.01)).toBe(true);
    expect(out.slice(18).every((f) => f.midi !== null && Math.abs(f.midi - 72) < 0.01)).toBe(true);
  });

  it("центрированная медиана гасит дрожание и не сдвигает смену ноты", () => {
    const jitter = Array.from({ length: 40 }, (_, i) => ({ midi: 60 + (i % 2 ? 0.15 : -0.15) + (i % 7 === 3 ? 0.4 : 0), clarity: 0.95, rms: 0.05 }));
    const out = decide(jitter).map((f) => f.midi!);
    const deltas = out.slice(1).map((m, i) => Math.abs(m - out[i]));
    expect(Math.max(...deltas.slice(3, -3))).toBeLessThanOrEqual(0.3 + 1e-9);
    const step = decide([...note(20, 60), ...note(20, 62)]).map((f) => f.midi);
    expect(step[19]).toBeCloseTo(60, 6);
    expect(step[20]).toBeCloseTo(62, 6);
  });
});

describe("детектор целиком на звуке", () => {
  const voicedShare = (windows: Float32Array[]) => {
    const track = createPitchTracker(RATE);
    const out = windows.map((w, i) => track(w, i * 0.01)).filter((f) => f.ready);
    return { share: out.filter((f) => f.midi !== null).length / out.length, out };
  };

  it("придыхание в середине ноты: линия не рвётся, хотя прежнее правило (ясность ≥ 0.85) рвало", () => {
    // Вдох шумом на 10 мс посреди ноты A3: три окна с ясностью около 0.7 между окнами 0.85–0.86.
    const r = rng(5);
    const total = 80 * HOP + 2048;
    const s = new Float32Array(total);
    let phase = 0;
    for (let i = 0; i < total; i++) {
      phase += (2 * Math.PI * 220) / RATE;
      let v = 0;
      for (let k = 1; k <= 8; k++) v += Math.sin(k * phase) / k;
      s[i] = 0.06 * v + (Math.abs(i - (40 * HOP + 1024)) < HOP / 2 ? 0.12 * r() : 0);
    }
    const windows = Array.from({ length: 80 }, (_, k) => s.slice(k * HOP, k * HOP + 2048));
    const analyse = createAnalyser(AUDIO.window);
    const strict = windows.filter((w) => analyse(w, RATE).clarity < AUDIO.clarity).length;
    expect(strict, "шум действительно опускает ясность ниже прежнего порога").toBeGreaterThanOrEqual(2);
    const track = createPitchTracker(RATE);
    const out = [...windows.map((w, i) => track(w, i * 0.01)).filter((f) => f.ready), ...track.flush()];
    expect(out.slice(5, 75).every((f) => f.midi !== null && Math.abs(f.midi - 57) < 0.1)).toBe(true);
  });

  it("flush отдаёт последние кадры: каждое окно — ровно один кадр", () => {
    const track = createPitchTracker(RATE);
    const windows = voice(Array.from({ length: 50 }, () => 57));
    const out = windows.map((w, i) => track(w, i * 0.01)).filter((f) => f.ready);
    const rest = track.flush();
    expect(out).toHaveLength(50 - VOICING.delay);
    expect(rest).toHaveLength(VOICING.delay);
    const times = [...out, ...rest].map((f) => Math.round(f.time * 100));
    expect(times).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(rest.every((f) => f.midi !== null)).toBe(true);
    expect(track.flush()).toEqual([]);
  });

  it("шум и тишина — не голос", () => {
    const r = rng(9);
    const noise = Array.from({ length: 100 }, () => Float32Array.from({ length: 2048 }, () => 0.05 * r()));
    expect(voicedShare(noise).share).toBe(0);
    expect(voicedShare(Array.from({ length: 50 }, () => new Float32Array(2048))).share).toBe(0);
  });
});
