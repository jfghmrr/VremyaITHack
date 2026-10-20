// Детектор высоты голоса в Worker: окно 2048 отсчётов, шаг ~10 мс (capture.worklet.js).
// Замер 2026-10-18 на вокале каталога: .superpowers/sdd/2026-10-16-hackathon-upgrade/pitch-report.md (основной checkout).
//
// 1. Анализ окна (createAnalyser): метод McLeod (MPM, NSDF) на автокорреляции pitchy (MIT), но
//    ключевые максимумы ищутся только среди периодов голоса 65–1100 Гц. pitchy искал по всему
//    окну, и ложный максимум на длинном сдвиге (там NSDF считается по немногим отсчётам) уводил
//    высоту ниже 65 Гц: такой кадр отбрасывался, хотя голос в нём был.
// 2. Решение о голосе (createVoicing) с задержкой VOICING.delay кадров (30 мс): кадр k решается,
//    когда уже видны кадры k+1…k+3.
//    * Начало ноты: clarity ≥ start (0.9) с подтверждением 2 из 3 следующих кадров, или протяжная
//      нота с clarity ≥ steady (0.85, прежний порог), если все 3 следующих кадра её продолжают с той
//      же ясностью. Одиночный ясный всплеск не становится голосом.
//    * Продолжение: кадр рядом с нотой (не дальше jump полутона) с clarity ≥ refresh (0.85) — всегда;
//      с clarity ≥ keep — только в окне hold (5 кадров, 50 мс) после кадра ноты ≥ renew (0.9) или
//      если такой кадр есть среди 3 следующих. Так придыхание и согласная внутри ноты не рвут
//      линию, а неясный тон (инструмент минуса, подсказка из наушников) не тянется за нотой.
//    * Опорная высота ноты — медиана её кадров с начала этой ноты: после паузы или скачка дальше
//      jump новая нота не сравнивается с прежней.
//    * Октавная ошибка внутри ноты (скачок ровно на ±12, который не держится в большинстве
//      следующих кадров) возвращается к ноте; настоящий скачок на октаву держится и принимается.
//    * Высота — медиана по центрированному окну до ±radius кадров той же ноты.
//    Порог громкости прежний (level.ts): ноту нельзя ни начать, ни продолжить тише порога попытки.
// Выход прежний: один кадр { time, midi | null } на окно; время кадра — центр его окна. Последние
// delay кадров отдаёт flush() (конец записи).
import { Autocorrelator } from "pitchy";
import { ANALYSIS, analysisGain, createNoteMeter, gateFor } from "./level";

export const AUDIO = { window: 2048, clarity: 0.85, rms: ANALYSIS.gate, minHz: 65, maxHz: 1100 };

export const VOICING = {
  /**
   * Ясность, с которой нота начинается сразу (подтверждение — 2 из 3 следующих кадров). Строже
   * прежнего единого порога 0.85; протяжные ноты 0.85–0.9 начинаются по правилу steady.
   */
  start: 0.9,
  /** Протяжная нота: начинается и с этой ясности, если все delay кадров впереди её продолжают с той же ясностью. */
  steady: 0.85,
  /** Кадр с такой ясностью рядом с нотой продолжает её без ограничения (как прежний порог 0.85). */
  refresh: 0.85,
  /** Ясность, с которой нота продолжается в окне hold или перед кадром ≥ bridge, если высота рядом. */
  keep: 0.55,
  /**
   * Окно после кадра ≥ renew: столько кадров (10 мс) ниже renew нота ещё продолжается и с ясностью
   * keep. Выбор владельца 2026-10-18 — больше распознанного пения ценой чуть большей доли «голоса»
   * на одном минусе (ASSUMPTIONS.md, pitch-report.md «Fix round 3»).
   */
  hold: 5,
  /** Ясность, с которой кадр открывает окно hold заново. */
  renew: 0.9,
  /** Неясный кадр продолжает ноту и вне окна hold, если среди delay кадров впереди есть кадр ноты с такой ясностью. */
  bridge: 0.9,
  /** Наибольшее отклонение от текущей ноты для продолжения, полутоны. */
  jump: 1.5,
  /** Задержка решения, кадров по 10 мс. */
  delay: 3,
  /** Сколько из следующих delay кадров должны продолжать ноту, чтобы она началась с ясности start. */
  confirm: 2,
  /** Радиус центрированной медианы высоты, кадров. */
  radius: 3,
};
export type VoicingOptions = typeof VOICING;

export interface Analysis {
  /** Высота, Гц; 0 — периода в диапазоне голоса нет. */
  hz: number;
  clarity: number;
  rms: number;
}

/** MPM по окну size отсчётов с поиском периода только в [minHz, maxHz]; k — константа McLeod. */
export function createAnalyser(size: number, minHz = AUDIO.minHz, maxHz = AUDIO.maxHz, k = 0.9) {
  const ac = Autocorrelator.forFloat32Array(size);
  const nsdf = new Float32Array(size);
  const refine = (i: number) => {
    // Парабола через три точки вокруг максимума (McLeod, раздел 5).
    const y0 = nsdf[i - 1];
    const y1 = nsdf[i];
    const y2 = nsdf[i + 1];
    const a = (y0 + y2) / 2 - y1;
    const b = (y2 - y0) / 2;
    if (a >= 0) return { tau: i, value: y1 };
    const x = -b / (2 * a);
    return { tau: i + x, value: y1 + (b * x) / 2 };
  };
  return (w: Float32Array, sampleRate: number): Analysis => {
    let energy = 0;
    for (let i = 0; i < w.length; i++) energy += w[i] * w[i];
    const rms = Math.sqrt(energy / w.length);
    if (!(energy > 0)) return { hz: 0, clarity: 0, rms };
    // Период не короче sampleRate / maxHz (ceil: верхняя граница — именно maxHz) и не длиннее sampleRate / minHz.
    const tauMin = Math.max(2, Math.ceil(sampleRate / maxHz));
    const tauMax = Math.min(w.length - 2, Math.ceil(sampleRate / minHz));
    // NSDF (McLeod, формула 9): 2·r'(tau) / m'(tau); m' уменьшается на края окна при каждом сдвиге.
    ac.autocorrelate(w, nsdf);
    let m = 2 * nsdf[0];
    for (let i = 0; i <= tauMax + 1; i++) {
      nsdf[i] = m > 0 ? (2 * nsdf[i]) / m : 0;
      m -= w[i] * w[i] + w[w.length - 1 - i] * w[w.length - 1 - i];
    }
    // Ключевые максимумы: наибольший между положительным и отрицательным переходом через ноль.
    // Учитываются и периоды до вдвое короче tauMin (1100–2200 Гц): тон выше 1100 Гц должен
    // отбрасываться, как раньше, а не попадать в диапазон октавой ниже (максимум на двойном периоде).
    const tauLow = Math.max(2, Math.floor(tauMin / 2));
    const peaks: { tau: number; value: number }[] = [];
    let looking = false;
    let at = -1;
    for (let i = 1; i <= tauMax; i++) {
      if (nsdf[i - 1] <= 0 && nsdf[i] > 0) {
        looking = true;
        at = i;
      } else if (nsdf[i - 1] > 0 && nsdf[i] <= 0) {
        if (looking && at >= tauLow) peaks.push(refine(at));
        looking = false;
      } else if (looking && nsdf[i] > nsdf[at]) at = i;
    }
    if (looking && at >= tauLow && at < tauMax) peaks.push(refine(at));
    if (!peaks.length) return { hz: 0, clarity: 0, rms };
    let top = 0;
    for (const p of peaks) top = Math.max(top, p.value);
    // Как у McLeod и pitchy: первый максимум не ниже k от наибольшего (период, а не его кратное).
    const chosen = peaks.find((p) => p.value >= k * top)!;
    const hz = sampleRate / chosen.tau;
    // Период короче tauMin (тон выше maxHz) или уточнение параболой за границей диапазона: кадр без высоты, как раньше.
    if (hz < minHz || hz > maxHz) return { hz: 0, clarity: Math.min(1, chosen.value), rms };
    return { hz, clarity: Math.min(1, chosen.value), rms };
  };
}

const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

type Pending = Analysis & { midi: number; time: number };
export type Decided = Analysis & { time: number; midi: number | null };

/**
 * Решение о голосе с задержкой o.delay кадров. push() принимает анализ нового окна и порог
 * громкости попытки и возвращает решённый кадр (на delay окон раньше) или null, пока задержка
 * не набрана. flush() решает оставшиеся кадры по тому, что уже видно (конец записи).
 * Громкость и ясность решённого кадра возвращаются как есть.
 */
export function createVoicing(o: VoicingOptions = VOICING) {
  const queue: Pending[] = [];
  /** Решённые высоты текущей ноты с её начала (сбрасываются на паузе и на новой ноте). */
  const note: number[] = [];
  /** Решённых кадров текущей ноты после её последнего ясного кадра. */
  let sinceClear = 0;
  const has = (a: Analysis) => a.hz > 0;
  const clear = (a: Analysis, gate: number) => has(a) && a.clarity >= o.bridge && a.rms >= gate;
  /** Кадр a продолжает ноту на высоте ref (октавная ошибка поправлена): его высота или null. */
  const follows = (a: Pending, ref: number, gate: number) => {
    if (!has(a) || a.clarity < o.keep || a.rms < gate) return null;
    let m = a.midi;
    if (Math.abs(m - ref - 12) < 1) m -= 12;
    else if (Math.abs(m - ref + 12) < 1) m += 12;
    return Math.abs(m - ref) <= o.jump ? m : null;
  };
  const decide = (gate: number): { m: number; onset: boolean } | null => {
    const a = queue[0];
    const ahead = queue.slice(1, 1 + o.delay);
    const need = Math.min(o.confirm, ahead.length);
    if (note.length && has(a) && a.rms >= gate) {
      const ref = median(note.slice(-5));
      let m = a.midi;
      const octave = Math.abs(m - ref - 12) < 1 ? 12 : Math.abs(m - ref + 12) < 1 ? -12 : 0;
      // Настоящий скачок на октаву держится в большинстве следующих кадров; ошибка детектора — нет.
      if (octave && ahead.filter((b) => has(b) && Math.abs(b.midi - a.midi) <= o.jump).length < need) m -= octave;
      if (Math.abs(m - ref) <= o.jump) {
        if (a.clarity >= o.refresh) return { m, onset: false };
        const recent = sinceClear < o.hold || ahead.some((b) => clear(b, gate) && follows(b, ref, gate) !== null);
        if (a.clarity >= o.keep && recent) return { m, onset: false };
      }
    }
    // Начало ноты, в том числе новой сразу после прежней (скачок дальше jump): ясный кадр,
    // подтверждённый следующими кадрами. Одиночный ясный кадр далеко от ноты — выброс, не скачок.
    if (!has(a) || a.rms < gate) return null;
    if (a.clarity >= o.start && ahead.filter((b) => follows(b, a.midi, gate) !== null).length >= need) return { m: a.midi, onset: true };
    // Протяжная нота чуть ниже start (придыхание, тихий микрофон): все кадры впереди с той же ясностью.
    if (a.clarity >= o.steady && ahead.length && ahead.every((b) => b.clarity >= o.steady && follows(b, a.midi, gate) !== null)) return { m: a.midi, onset: true };
    return null;
  };
  const next = (gate: number): Decided => {
    const d = decide(gate);
    const a = queue[0];
    let midi: number | null = null;
    if (!d) {
      note.length = 0;
      sinceClear = 0;
    } else {
      if (d.onset) note.length = 0;
      sinceClear = a.clarity >= o.renew ? 0 : sinceClear + 1;
      // Центрированная медиана: предыдущие кадры этой ноты и продолжающие её кадры после.
      const values = [d.m];
      for (let k = note.length - 1; k >= 0 && note.length - k <= o.radius; k--) {
        if (Math.abs(note[k] - d.m) > o.jump) break;
        values.push(note[k]);
      }
      for (let k = 1; k <= o.radius && k < queue.length; k++) {
        const v = follows(queue[k], d.m, gate);
        if (v === null) break;
        values.push(v);
      }
      midi = median(values);
      note.push(d.m);
      if (note.length > 8) note.shift();
    }
    const { time, hz, clarity, rms } = queue.shift()!;
    return { time, hz, clarity, rms, midi };
  };
  return {
    push(a: Analysis & { time: number }, gate: number): Decided | null {
      queue.push({ ...a, midi: has(a) ? midiOf(a.hz) : NaN });
      return queue.length <= o.delay ? null : next(gate);
    },
    /** Решить все ожидающие кадры (без недостающих кадров впереди) и начать заново. */
    flush(gate: number): Decided[] {
      const out: Decided[] = [];
      while (queue.length) out.push(next(gate));
      note.length = 0;
      sinceClear = 0;
      return out;
    },
  };
}

export function createPitchTracker(sampleRate: number, o: VoicingOptions = VOICING) {
  const analyse = createAnalyser(AUDIO.window);
  const voicing = createVoicing(o);
  const meter = createNoteMeter();
  let measuring = false;
  let gate = AUDIO.rms;
  /**
   * Окно data с центром в момент time (часы AudioContext). Возвращает решённый кадр на
   * o.delay окон раньше; первые delay вызовов — ready: false (кадра ещё нет).
   */
  const track = (data: Float32Array, time = 0) => {
    const a = analyse(data, sampleRate);
    // Замер ноты на проверке микрофона — по ясным кадрам, как раньше (clarity ≥ 0.85, 65–1100 Гц).
    if (measuring) gate = gateFor(meter.update(a.rms, a.hz >= AUDIO.minHz && a.hz <= AUDIO.maxHz && a.clarity >= AUDIO.clarity));
    const gain = analysisGain(gate);
    const f = voicing.push({ ...a, time }, gate);
    if (!f) return { time, midi: null, clarity: a.clarity, rms: a.rms, gain, ready: false };
    return { time: f.time, midi: f.midi, clarity: f.clarity, rms: f.rms, gain, ready: true };
  };
  /** Проверка микрофона: замерять ноту певца и подстраивать порог. Выключено — порог зафиксирован (попытка). */
  const measure = (on: boolean) => {
    // Нота не должна склеиваться через перерыв замера (фрагмент песни из динамика): кадры до и после не подряд.
    meter.reset();
    measuring = on;
  };
  /** Конец записи: отдать последние o.delay кадров, решённых по уже видимым окнам. */
  const flush = () => {
    const gain = analysisGain(gate);
    return voicing.flush(gate).map((f) => ({ time: f.time, midi: f.midi, clarity: f.clarity, rms: f.rms, gain, ready: true }));
  };
  return Object.assign(track, { measure, flush });
}
