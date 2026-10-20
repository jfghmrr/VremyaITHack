// Линия голоса певца на графиках (сцена PianoRoll, проверка микрофона LiveTrace, разбор
// ResultTrace): только отображение. Оценка, история и дуэли получают сырые кадры детектора.
//
// 1. Куски: кадры с высотой, идущие подряд (шаг между соседями не больше stepMax; сравнение с
//    запасом EPS, чтобы решение не зависело от округления времени).
// 2. Лёгкое сглаживание внутри куска: медиана по 3 кадрам (убирает одиночный выброс и не
//    размывает ступеньку между нотами), затем среднее по 3 кадрам только между соседями ближе
//    jump полутона (приглушает дрожание, переход между нотами остаётся резким). Скачок от split
//    полутонов между соседними кадрами рвёт линию: вертикальная «игла» не рисуется.
// 3. Мостики: соседние куски соединяются, если разрыв между их крайними кадрами не длиннее bridgeS
//    и высота по краям отличается не больше bridgeSemitones. Это согласные и короткие провалы
//    распознавания внутри спетой ноты. Паузы длиннее bridgeS и скачки шире остаются разрывами:
//    высота через них не придумывается.
//    Своя линия (кадры 10 мс): мостик до 80 мс. Линия соперника или призрака (каноническая кривая
//    50 мс): мостик через одну пропущенную точку, то есть до 100 мс между соседними точками.
export const VOICE = {
  /** Кадры дальше этого друг от друга — разные куски, с (кадры 10 мс: любой пропуск — уже мостик). */
  stepMax: 0.015,
  /** Самый длинный соединяемый разрыв между крайними кадрами соседних кусков, с. */
  bridgeS: 0.08,
  /** Наибольшая разница высоты по краям соединяемого разрыва, полутоны. */
  bridgeSemitones: 1.5,
  /** Граница нот для сглаживания, полутоны. */
  jump: 1,
  /** Скачок между соседними кадрами, на котором линия рвётся (без вертикальной «иглы»), полутоны. */
  split: 5,
  /** Сглаживать ли кусок (у кривой соперника шаг 50 мс: три точки — уже 150 мс, не сглаживаем). */
  smooth: true,
};
export type VoiceOptions = typeof VOICE;

/** Линия соперника или призрака: кривая 50 мс, без сглаживания, мостик до 100 мс (одна пропущенная точка). */
export const RIVAL_LINE: VoiceOptions = { stepMax: 0.06, bridgeS: 0.1, bridgeSemitones: 1.5, jump: 1, split: 5, smooth: false };

/** Допуск сравнения времени кадров, с. */
const EPS = 1e-6;

export type VoicePoint = { t: number; m: number };
type Frame = { t: number; midi: number | null };

/**
 * Точки линии в переиспользуемых буферах: t, m — время и высота точки k, start[k] = 1 — с точки k
 * начинается новая часть. Перерисовка на каждом кадре анимации ничего не выделяет.
 */
export interface VoicePath {
  t: Float64Array;
  m: Float64Array;
  start: Uint8Array;
  tmp: Float64Array;
  n: number;
}

export function createVoicePath(capacity = 1024): VoicePath {
  return { t: new Float64Array(capacity), m: new Float64Array(capacity), start: new Uint8Array(capacity), tmp: new Float64Array(capacity), n: 0 };
}

function grow(p: VoicePath) {
  const size = p.t.length * 2;
  const copy = <T extends Float64Array | Uint8Array>(a: T, b: T) => (b.set(a), b);
  p.t = copy(p.t, new Float64Array(size));
  p.m = copy(p.m, new Float64Array(size));
  p.start = copy(p.start, new Uint8Array(size));
  p.tmp = new Float64Array(size);
}

/** Сгладить кусок [a, b) и отметить начала частей (мостик к предыдущему куску или разрыв). */
function finishRun(p: VoicePath, a: number, b: number, o: VoiceOptions) {
  if (b <= a) return;
  const { t, m, tmp, start } = p;
  if (o.smooth) {
    for (let k = a; k < b; k++) {
      if (k === a || k === b - 1) tmp[k] = m[k];
      else {
        const x = m[k - 1];
        const y = m[k];
        const z = m[k + 1];
        tmp[k] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
      }
    }
    for (let k = a; k < b; k++) {
      let sum = tmp[k];
      let n = 1;
      if (k > a && Math.abs(tmp[k - 1] - tmp[k]) < o.jump) (sum += tmp[k - 1]), n++;
      if (k + 1 < b && Math.abs(tmp[k + 1] - tmp[k]) < o.jump) (sum += tmp[k + 1]), n++;
      m[k] = sum / n;
    }
  }
  start[a] = a > 0 && t[a] - t[a - 1] <= o.bridgeS + EPS && Math.abs(m[a] - m[a - 1]) <= o.bridgeSemitones ? 0 : 1;
  for (let k = a + 1; k < b; k++) start[k] = Math.abs(m[k] - m[k - 1]) >= o.split ? 1 : 0;
}

/**
 * Заполнить path точками линии из кадров frames[i0, i1) (по возрастанию t) внутри окна [from, to].
 * Исходные кадры не меняются.
 */
export function voicePath(path: VoicePath, frames: readonly Frame[], i0 = 0, i1 = frames.length, from = -Infinity, to = Infinity, o: VoiceOptions = VOICE): VoicePath {
  let n = 0;
  let run = 0;
  let lastT = -Infinity;
  for (let i = i0; i < i1; i++) {
    const f = frames[i];
    if (f.t < from || f.t > to || f.midi === null || !Number.isFinite(f.midi)) continue;
    if (f.t - lastT > o.stepMax + EPS) {
      finishRun(path, run, n, o);
      run = n;
    }
    if (n === path.t.length) grow(path);
    path.t[n] = f.t;
    path.m[n] = f.midi;
    n++;
    lastT = f.t;
  }
  finishRun(path, run, n, o);
  path.n = n;
  return path;
}

/** Те же части объектами (тесты и редкие перерисовки). */
export function voiceParts(frames: readonly Frame[], from = -Infinity, to = Infinity, o: VoiceOptions = VOICE): VoicePoint[][] {
  const p = voicePath(createVoicePath(Math.max(16, frames.length)), frames, 0, frames.length, from, to, o);
  const parts: VoicePoint[][] = [];
  for (let k = 0; k < p.n; k++) {
    if (p.start[k]) parts.push([]);
    parts[parts.length - 1].push({ t: p.t[k], m: p.m[k] });
  }
  return parts;
}
