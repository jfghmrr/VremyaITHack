// Линия эталона на графике сцены пения (PianoRoll): только отображение, оценку считает ядро.
//
// Эталоны каталога — живой вокал: высота меняется каждые 10 мс на десятые доли полутона.
// Раньше линия собиралась из ровных «нот» (новая нота — при отходе на 0,3 полутона от начала),
// живой голос рвался на куски по 20–200 мс, а концы каждого куска отступали внутрь на радиус
// круглого конца. Куски короче толщины линии схлопывались в отрезок нулевой длины, который
// Canvas не обводит ни в Chromium, ни в WebKit: на телефоне от линии оставались редкие точки.
// Теперь линия идёт за кривой кадр за кадром и рвётся только на паузе или скачке между
// соседними кадрами от JUMP полутона. Быстрый спад голоса в конце фразы (до 0,6 полутона
// за кадр) остаётся одной линией. У синтезированных эталонов скачок на полутон и больше —
// граница нот, поэтому их ноты остаются отдельными ровными полосами, как раньше.
//
// Второй шаг (2026-10-17, только картинка): у нескольких эталонов голос распознан рваными
// кусками по 70–80 мс с паузами по 30–150 мс между ними, и на телефоне (9 с на 336 px) линия
// всё равно выглядела россыпью точек. Поэтому для графика:
//   * окно времени зависит от ширины (stageSpan): около 55 px на секунду, как на ноутбуке,
//     но не меньше MIN_SPAN секунд, чтобы певец видел, что впереди;
//   * displayCurve сглаживает дрожание голоса внутри озвученного куска (при шаге эталона 10 мс —
//     медиана по 5 кадрам, 50 мс, затем среднее по 7 кадрам, 70 мс) и соединяет короткие паузы
//     (до BRIDGE_S) внутри фразы, если высота по краям паузы отличается не больше чем на
//     BRIDGE_SEMITONES. Паузы между фразами и длинные паузы не соединяются.
// reference.json, версия песни и оценка не меняются: ядро считает по исходной кривой.
export const JUMP = 1;
/** Плотность графика, px на секунду, и границы окна времени в секундах. */
export const PX_PER_S = 55;
export const MIN_SPAN = 6;
export const MAX_SPAN = 9;
/** Самая длинная пауза внутри фразы, которую линия перекрывает, с. */
export const BRIDGE_S = 0.15;
/** Наибольшая разница высоты по краям перекрываемой паузы, полутоны. */
export const BRIDGE_SEMITONES = 2;
/**
 * Параметр окна скользящего среднего, с. Радиус — Math.round(SMOOTH_S / hop / 2) кадров: при шаге
 * 10 мс это 3 кадра в каждую сторону, то есть окно 7 кадров (70 мс), а не 50 мс.
 */
export const SMOOTH_S = 0.05;

export type LinePoint = { x: number; m: number };

/** Окно графика в секундах для ширины холста в CSS px. */
export function stageSpan(width: number): number {
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, width / PX_PER_S));
}

/** Синтезированный эталон: все озвученные кадры — целые MIDI (ровные ноты). Его линия не меняется. */
export function isSynthesized(f0: (number | null)[]): boolean {
  let voiced = 0;
  for (const m of f0) {
    if (m === null) continue;
    voiced++;
    if (Math.abs(m - Math.round(m)) > 1e-6) return false;
  }
  return voiced > 0;
}

/**
 * Кривая для отображения: медианное сглаживание внутри озвученных кусков и мостики через
 * короткие паузы внутри фразы (линейная интерполяция высоты). Синтезированный эталон
 * возвращается без изменений. Исходный массив не меняется.
 */
export function displayCurve(f0: (number | null)[], hop: number, phrases: { start_s: number; end_s: number }[] = []): (number | null)[] {
  if (isSynthesized(f0)) return f0.slice();
  const out: (number | null)[] = new Array(f0.length).fill(null);
  // Внутри куска без пауз и без скачков от JUMP полутона (граница нот и пауза не размываются):
  // медиана убирает одиночные выбросы распознавания, затем скользящее среднее приглушает мелкое
  // дрожание. При шаге 10 мс радиус медианы Math.round(0.03 / hop / 2) = 2 (окно 5 кадров, 50 мс),
  // радиус среднего Math.round(SMOOTH_S / hop / 2) = 3 (окно 7 кадров, 70 мс). Вибрато (период
  // около 0,2 с) почти не меняется.
  const medianRadius = Math.max(0, Math.round(0.03 / hop / 2));
  const meanRadius = Math.max(0, Math.round(SMOOTH_S / hop / 2));
  let i = 0;
  while (i < f0.length) {
    if (f0[i] === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < f0.length && f0[j] !== null && Math.abs(f0[j]! - f0[j - 1]!) < JUMP) j++;
    const med: number[] = [];
    for (let k = i; k < j; k++) {
      const window: number[] = [];
      for (let q = Math.max(i, k - medianRadius); q <= Math.min(j - 1, k + medianRadius); q++) window.push(f0[q]!);
      window.sort((a, b) => a - b);
      const mid = window.length >> 1;
      med.push(window.length % 2 ? window[mid] : (window[mid - 1] + window[mid]) / 2);
    }
    for (let k = 0; k < med.length; k++) {
      let sum = 0;
      let n = 0;
      for (let q = Math.max(0, k - meanRadius); q <= Math.min(med.length - 1, k + meanRadius); q++) {
        sum += med[q];
        n++;
      }
      out[i + k] = sum / n;
    }
    i = j;
  }
  // Мостики через короткие паузы внутри одной фразы.
  const maxGap = Math.round(BRIDGE_S / hop);
  const inOnePhrase = (a: number, b: number) =>
    !phrases.length || phrases.some((p) => p.start_s <= a + 1e-9 && b <= p.end_s + 1e-9);
  i = 0;
  while (i < out.length) {
    if (out[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const before = out[i - 1];
    const after = out[j];
    if (i > 0 && j < out.length && before != null && after != null && j - i <= maxGap && Math.abs(after - before) <= BRIDGE_SEMITONES && inOnePhrase((i - 1) * hop, j * hop)) {
      for (let k = i; k < j; k++) out[k] = before + ((after - before) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

/**
 * Ломаные эталона в пикселях окна [left, left + span) секунд шириной width.
 * Концы каждой части отступают внутрь на inset (радиус круглого конца линии), чтобы полоса
 * заканчивалась на границе кадра, но часть всегда сохраняет ненулевую длину: не меньше 1 px
 * или всю свою ширину, если она уже пикселя. Высота на концах — у кадра под отступившим
 * концом; внутри — не больше одной точки на пиксель.
 */
export function referencePath(f0: (number | null)[], hop: number, left: number, span: number, width: number, inset = 5): LinePoint[][] {
  const x = (t: number) => ((t - left) / span) * width;
  const frameAt = (px: number, start: number, end: number) => Math.min(end - 1, Math.max(start, Math.floor((left + (px / width) * span) / hop)));
  const i0 = Math.max(0, Math.floor(left / hop));
  const i1 = Math.min(f0.length, Math.ceil((left + span) / hop) + 1);
  const out: LinePoint[][] = [];
  let start = -1;
  // Кадры [start, end) озвучены и идут без скачков.
  const flush = (end: number) => {
    if (start < 0) return;
    const x0 = x(start * hop);
    const x1 = x(end * hop);
    const pad = Math.min(inset, Math.max(0, (x1 - x0 - 1) / 2));
    const a = x0 + pad;
    const b = x1 - pad;
    const part: LinePoint[] = [{ x: a, m: f0[frameAt(a, start, end)]! }];
    let last = a;
    for (let i = start; i < end; i++) {
      const xi = x((i + 0.5) * hop);
      if (xi > a && xi < b && xi - last >= 1) {
        part.push({ x: xi, m: f0[i]! });
        last = xi;
      }
    }
    part.push({ x: b, m: f0[frameAt(b, start, end)]! });
    out.push(part);
    start = -1;
  };
  for (let i = i0; i < i1; i++) {
    const m = f0[i];
    if (m === null || (start >= 0 && Math.abs(m - f0[i - 1]!) >= JUMP)) flush(i);
    if (m !== null && start < 0) start = i;
  }
  flush(i1);
  return out;
}
