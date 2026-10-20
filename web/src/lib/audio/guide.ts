// Синтезированный «Ориентир» на экране результата: мелодия эталона в тональности певца
// мягким голосом. Звук считается заранее в Float32Array (без DOM, проверяется в Vitest) и
// играет одним AudioBufferSourceNode синхронно с минусом.
//
// Прежний синтезатор звучал странно: высота брала местную тональность каждые 100 мс (в
// местах, где певец молчал, ориентир прыгал в исходную тональность или октаву), следовала
// каждому дрожанию эталона, громкость обрывалась на каждом беззвучном кадре 20 мс, а тембр
// был пилой через полосовые фильтры («кузнечик в банке»).
import type { ScoreResult } from "#lib/scoring/types.ts";

export const GUIDE_RATE = 22050;
/** Предел пика ориентира (на деле около 0,22): вместе с минусом (0,65) ниже 0 dBFS. */
export const GUIDE_PEAK = 0.35;
/** Паузы короче этого (согласные, вдох внутри фразы) звучат легато. */
const FILL_GAP_S = 0.12;
/** Обрывки эталона короче этого не звучат. */
const MIN_NOTE_S = 0.08;
/** Медиана по 9 кадрам (90 мс) убирает дрожание и октавные ошибки распознавания высоты. */
const MEDIAN_RADIUS = 4;
const ATTACK_S = 0.05;
const RELEASE_S = 0.09;
/** Портаменто: высота догоняет ноту с постоянной времени 30 мс. */
const GLIDE_S = 0.03;
const MAX_HARMONICS = 12;
const TOP_HZ = 4000;
const BLOCK = 32;

export interface GuideSegment {
  start: number;
  end: number;
  /** Высота (MIDI) по кадрам эталона от `start`, уже в тональности певца. */
  midi: number[];
}

const ms = (x: number) => Math.round(x * 1000) / 1000;

function median(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Одна тональность певца на всю песню: общий сдвиг с октавой из оценки, до 0,1 полутона. */
export function guideShift(result: Pick<ScoreResult, "registerShift">) {
  return Number.isFinite(result.registerShift) ? Math.round(result.registerShift * 10) / 10 : 0;
}

/** Фразы ориентира из эталона: короткие паузы склеены, обрывки убраны, высота сглажена. */
export function guideSegments(f0: (number | null)[], hopS: number, shift: number): GuideSegment[] {
  const values = f0.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const runs: [number, number][] = [];
  for (let i = 0; i < values.length; ) {
    if (values[i] === null) {
      i++;
      continue;
    }
    let j = i;
    while (j < values.length && values[j] !== null) j++;
    const last = runs.at(-1);
    if (last && i - last[1] < Math.round(FILL_GAP_S / hopS)) {
      const a = values[last[1] - 1]!;
      const b = values[i]!;
      const steps = i - last[1] + 1;
      for (let k = last[1]; k < i; k++) values[k] = a + ((b - a) * (k - last[1] + 1)) / steps;
      last[1] = j;
    } else runs.push([i, j]);
    i = j;
  }
  return runs
    .filter(([a, b]) => b - a >= Math.round(MIN_NOTE_S / hopS))
    .map(([a, b]) => {
      const raw = values.slice(a, b) as number[];
      const midi = raw.map((_, i) => median(raw.slice(Math.max(0, i - MEDIAN_RADIUS), i + MEDIAN_RADIUS + 1)) + shift);
      return { start: ms(a * hopS), end: ms(b * hopS), midi };
    });
}

/** Мягкий «у»-образный тембр: основной тон сильнее всех, гармоники спадают, лёгкий подъём около 500 и 900 Гц. */
function spectrum(f0: number, out: Float64Array): number {
  const count = Math.max(1, Math.min(MAX_HARMONICS, Math.floor(TOP_HZ / f0)));
  let sum = 0;
  for (let h = 1; h <= count; h++) {
    const f = h * f0;
    const formant = 1 + 0.8 * Math.exp(-(((f - 500) / 200) ** 2)) + 0.4 * Math.exp(-(((f - 900) / 250) ** 2));
    // У верхней границы гармоника затихает плавно, а не исчезает щелчком при смене высоты.
    const edge = h === 1 ? 1 : Math.min(1, Math.max(0, (TOP_HZ - f) / 400));
    out[h] = h ** -1.5 * formant * edge;
    sum += out[h];
  }
  for (let h = 1; h <= count; h++) out[h] /= sum;
  return count;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Звук ориентира длиной `duration` секунд: каждая фраза с мягкой атакой и затуханием, внутри
 * фразы высота скользит от ноты к ноте, фаза непрерывна, вне фраз — тишина.
 */
export function renderGuide(segments: GuideSegment[], duration: number, rate = GUIDE_RATE, hopS = 0.01): Float32Array<ArrayBuffer> {
  const n = Math.max(0, Math.round(duration * rate));
  const out = new Float32Array(n);
  const amps = new Float64Array(MAX_HARMONICS + 1);
  const attack = ATTACK_S * rate;
  const release = RELEASE_S * rate;
  const alpha = 1 - Math.exp(-1 / (GLIDE_S * rate));
  segments.forEach((seg, index) => {
    if (!seg.midi.length) return;
    const s0 = Math.round(seg.start * rate);
    const sEnd = Math.round(seg.end * rate);
    const next = index + 1 < segments.length ? Math.round(segments[index + 1].start * rate) : n;
    const s1 = Math.min(n, next, sEnd + Math.ceil(release));
    const last = seg.midi.length - 1;
    let midi = seg.midi[0];
    let phase = 0;
    let count = 1;
    for (let i = s0; i < s1; i++) {
      const x = Math.min(last, Math.max(0, (i - s0) / rate / hopS));
      const k = Math.floor(x);
      const target = k >= last ? seg.midi[last] : seg.midi[k] + (seg.midi[k + 1] - seg.midi[k]) * (x - k);
      midi += (target - midi) * alpha;
      const f = hz(midi);
      if ((i - s0) % BLOCK === 0) count = spectrum(f, amps);
      phase += (2 * Math.PI * f) / rate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      // sin(h·phi) по рекурсии Чебышёва: одна пара sin/cos на отсчёт.
      const c = Math.cos(phase);
      let previous = 0;
      let current = Math.sin(phase);
      let sum = 0;
      for (let h = 1; h <= count; h++) {
        sum += amps[h] * current;
        const following = 2 * c * current - previous;
        previous = current;
        current = following;
      }
      const t = i - s0;
      let envelope = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1;
      const r = i - sEnd;
      if (r >= 0) envelope = Math.min(envelope, r >= release ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * r) / release));
      out[i] = GUIDE_PEAK * envelope * sum;
    }
  });
  return out;
}
