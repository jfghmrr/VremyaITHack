// Сдвиг тональности линии голоса на сцене пения (PianoRoll): только картинка. Оценка, история и
// дуэли считают свой сдвиг в ядре (scoring-core) и этот не используют.
//
// Владелец (2026-10-18): своя линия во время пения скакала вверх и вниз относительно эталона.
// Раньше сдвиг был медианой (голос − эталон) за последние 3 с, пересчитывался 10 раз в секунду и
// применялся ко всей видимой линии: новая фраза, фальшивое место или срыв на октаву сдвигали и то,
// что уже было нарисовано.
//
// Теперь:
// 1. Оценка — правило тональности ядра (score.rs: круговая медиана по высотному классу, октава —
//    медианой отклонений) по последним windowS секундам кадров, где есть и голос, и эталон;
//    сдвиг — целое число полутонов.
// 2. Старт: пока таких кадров меньше startS секунд, сдвига нет и линия не рисуется. Первая оценка
//    действует на все кадры до неё, поэтому появление сдвига линию не двигает.
// 3. Гистерезис: новый сдвиг принимается, только когда округлённая оценка отличается от текущего
//    сдвига (на целый полутон или больше), сама оценка дальше margin от него, последние recentS
//    секунд пения дают тот же сдвиг, и всё это держится holdS секунд озвученных кадров подряд.
//    Без проверки последних секунд длинное окно запаздывает и в обратную сторону: после 4 с в
//    другой тональности сдвиг сменился бы, когда певец уже вернулся.
// 4. Сдвиг кусочно-постоянный по времени: новый действует с кадра, на котором принят, и дальше.
//    Уже нарисованные кадры сохраняют свой сдвиг до конца попытки, а на смене сдвига линия
//    разрывается (без придуманного вертикального отрезка).
// 5. Кадры начались заново (рестарт песни, новый круг тренировки): прежний сдвиг служит начальным
//    для всех новых кадров, поэтому линия видна с первой ноты, а окно оценки продолжает копиться
//    (фраза тренировки бывает короче секунды голоса: круг за кругом сдвиг всё равно появится).
//    Тренировка задаёт и начальный сдвиг — тональность певца из оценки попытки (seedStageKey).
// В цикле анимации ничего не выделяется: кольцевой буфер и буфер медианы — типизированные массивы;
// новый массив появляется только при смене сдвига (несколько раз за песню).

export const STAGE_KEY = {
  /** Сколько секунд кадров с голосом и эталоном нужно для первого сдвига. */
  startS: 1,
  /** Окно оценки: последние секунды кадров с голосом и эталоном. */
  windowS: 6,
  /** Сколько секунд озвученных кадров новая оценка должна держаться, чтобы сдвиг сменился. */
  holdS: 2,
  /** Последние секунды пения, которые тоже должны давать новый сдвиг, пока он держится. */
  recentS: 1,
  /** Оценка пересчитывается через столько секунд новых кадров с голосом и эталоном. */
  everyS: 0.1,
  /** Оценка должна отойти от текущего сдвига хотя бы на столько полутонов (не дрожать на ±0,5). */
  margin: 0.6,
};
export type StageKeyOptions = typeof STAGE_KEY;

type Frame = { t: number; midi: number | null };

export interface StageKey {
  /** Шаг кадров, с: 0,01 у своей линии, 0,05 у кривой соперника. */
  step: number;
  o: StageKeyOptions;
  /** Кольцевой буфер разностей голос − эталон, полутоны. */
  ring: Float64Array;
  scratch: Float64Array;
  /** Последние recentS секунд разностей (копия из кольца для оценки). */
  recent: Float64Array;
  size: number;
  head: number;
  /** Кадров с голосом и эталоном с прошлой оценки. */
  pending: number;
  /** Сколько кадров уже прочитано и время последнего из них (новый массив кадров — новая попытка). */
  count: number;
  lastT: number;
  /** Текущий сдвиг, целые полутоны; NaN — ещё нет. */
  offset: number;
  /** Сдвиг value[k] действует с времени from[k] (from[0] = −∞). */
  from: number[];
  value: number[];
  candidate: number;
  held: number;
  /** Меняется при каждом изменении from/value: ключ кеша линии. */
  version: number;
  /** Постоянный сдвиг (призрак: сдвиг из его оценки), без живой оценки. */
  fixed: boolean;
}

export function createStageKey(step: number, o: StageKeyOptions = STAGE_KEY): StageKey {
  const capacity = Math.max(1, Math.ceil(o.windowS / step - 1e-9));
  return {
    step,
    o,
    ring: new Float64Array(capacity),
    scratch: new Float64Array(capacity),
    recent: new Float64Array(Math.min(capacity, Math.max(1, Math.ceil(o.recentS / step - 1e-9)))),
    size: 0,
    head: 0,
    pending: 0,
    count: 0,
    lastT: NaN,
    offset: NaN,
    from: [],
    value: [],
    candidate: NaN,
    held: 0,
    version: 0,
    fixed: false,
  };
}

/** Новая попытка: прежний сдвиг (если был) становится начальным для всех кадров; окно оценки остаётся. */
function restart(key: StageKey) {
  key.pending = 0;
  key.count = 0;
  key.lastT = NaN;
  key.candidate = NaN;
  key.held = 0;
  key.from = Number.isFinite(key.offset) ? [-Infinity] : [];
  key.value = Number.isFinite(key.offset) ? [key.offset] : [];
  key.version++;
}

/**
 * Начальный сдвиг, пока своего ещё нет (тренировка: сдвиг тональности из оценки попытки,
 * округлённый до полутона). Дальше сдвиг меняется по обычным правилам.
 */
export function seedStageKey(key: StageKey, shift: number) {
  if (key.fixed || Number.isFinite(key.offset) || !Number.isFinite(shift)) return;
  key.offset = Math.round(shift) + 0;
  key.from = [-Infinity];
  key.value = [key.offset];
  key.version++;
}

/** Постоянный сдвиг для всех кадров (линия призрака: сдвиг из оценки его попытки). */
export function fixStageKey(key: StageKey, shift: number) {
  if (key.fixed && key.offset === shift) return;
  key.fixed = true;
  key.offset = shift;
  key.from = [-Infinity];
  key.value = [shift];
  key.version++;
}

/** Свернуть разность высот в [−6, 6) полутонов (как wrap в scoring-core). */
const wrap = (x: number) => ((((x + 6) % 12) + 12) % 12) - 6;

/** k-й по величине элемент a[0, n) на месте (быстрый выбор); слева от него — не больше его. */
function select(a: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const x = a[i];
        a[i] = a[j];
        a[j] = x;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/** Медиана a[0, n), порядок элементов меняется. */
export function medianInPlace(a: Float64Array, n: number): number {
  if (n <= 0) return 0;
  const m = n >> 1;
  const upper = select(a, n, m);
  if (n % 2) return upper;
  let lower = -Infinity;
  for (let k = 0; k < m; k++) if (a[k] > lower) lower = a[k];
  return (lower + upper) / 2;
}

/**
 * Сдвиг тональности по разностям ds[0, n) голос − эталон — правило ядра оценки (score.rs):
 * круговая медиана по высотному классу (сетка 0,1 полутона, уточнение медианой), затем октава —
 * округлённая медиана отклонений в октавах. Срыв на октаву у меньшинства кадров её не меняет.
 * scratch — буфер не короче n.
 */
export function keyEstimate(ds: Float64Array, n: number, scratch: Float64Array): number {
  if (n <= 0) return 0;
  // Высотный класс один раз: дальше wrap(d − s) = класс − s, свёрнутый одним сравнением.
  for (let k = 0; k < n; k++) scratch[k] = wrap(ds[k]);
  let best = 0;
  let cost = Infinity;
  for (let q = -60; q < 60; q++) {
    const s = q / 10;
    let c = 0;
    for (let k = 0; k < n; k++) {
      let v = scratch[k] - s;
      if (v >= 6) v -= 12;
      else if (v < -6) v += 12;
      c += v < 0 ? -v : v;
    }
    if (c < cost) {
      cost = c;
      best = s;
    }
  }
  for (let k = 0; k < n; k++) scratch[k] = wrap(ds[k] - best);
  const key = wrap(best + medianInPlace(scratch, n));
  for (let k = 0; k < n; k++) scratch[k] = (ds[k] - key) / 12;
  return key + 12 * Math.round(medianInPlace(scratch, n));
}

/** Оценка по последним recentS секундам кольца. */
function recentEstimate(key: StageKey): number {
  const cap = key.ring.length;
  const n = Math.min(key.size, key.recent.length);
  for (let k = 0; k < n; k++) key.recent[k] = key.ring[(key.head - 1 - k + cap) % cap];
  return keyEstimate(key.recent, n, key.scratch);
}

function estimate(key: StageKey, t: number) {
  const { o } = key;
  if (!Number.isFinite(key.offset)) {
    if (key.size * key.step < o.startS - 1e-9) return;
    key.offset = Math.round(keyEstimate(key.ring, key.size, key.scratch)) + 0; // без −0
    key.from = [-Infinity];
    key.value = [key.offset];
    key.version++;
    return;
  }
  const e = keyEstimate(key.ring, key.size, key.scratch);
  const next = Math.round(e) + 0;
  if (next === key.offset || Math.abs(e - key.offset) < o.margin || Math.round(recentEstimate(key)) !== next) {
    key.candidate = NaN;
    key.held = 0;
    return;
  }
  if (next === key.candidate) key.held += Math.max(1, Math.round(o.everyS / key.step)) * key.step;
  else {
    key.candidate = next;
    key.held = 0;
  }
  if (key.held < o.holdS - 1e-9) return;
  key.offset = next;
  key.from.push(t);
  key.value.push(next);
  key.candidate = NaN;
  key.held = 0;
  key.version++;
}

/**
 * Прочитать новые кадры (по возрастанию t; массив может пересоздаваться с тем же началом, как
 * кривая соперника). Короче прежнего или с другим временем на прежнем месте — новая попытка.
 */
export function updateStageKey(key: StageKey, frames: readonly Frame[], f0: readonly (number | null)[], hop: number) {
  if (key.fixed) {
    key.fixed = false;
    key.offset = NaN;
    key.size = 0;
    key.head = 0;
    restart(key);
  }
  if (frames.length < key.count || (key.count > 0 && frames[key.count - 1].t !== key.lastT)) restart(key);
  const every = Math.max(1, Math.round(key.o.everyS / key.step));
  for (let i = key.count; i < frames.length; i++) {
    const f = frames[i];
    if (f.midi === null || !Number.isFinite(f.midi)) continue;
    const r = f0[Math.round(f.t / hop)];
    if (r == null) continue;
    key.ring[key.head] = f.midi - r;
    key.head = (key.head + 1) % key.ring.length;
    if (key.size < key.ring.length) key.size++;
    if (++key.pending >= every) {
      key.pending = 0;
      estimate(key, f.t);
    }
  }
  key.count = frames.length;
  key.lastT = frames.length ? frames[frames.length - 1].t : NaN;
}

/** Сдвиг, с которым рисуется кадр времени t; NaN — сдвига ещё нет (кадр не рисуется). */
export function stageKeyAt(key: StageKey, t: number): number {
  for (let k = key.from.length - 1; k >= 0; k--) if (key.from[k] <= t) return key.value[k];
  return NaN;
}

/**
 * Сдвиг каждой точки линии (точки по возрастанию t) в into.off; на смене сдвига линия
 * разрывается (path.start). false — сдвига ещё нет, линию не рисовать.
 */
export function stageOffsets(key: StageKey, path: { t: Float64Array; start: Uint8Array; n: number }, into: { off: Float64Array }): boolean {
  if (!key.value.length) return false;
  if (into.off.length < path.n) into.off = new Float64Array(path.t.length);
  const { from, value } = key;
  let s = 0;
  for (let k = 0; k < path.n; k++) {
    while (s + 1 < from.length && from[s + 1] <= path.t[k]) s++;
    into.off[k] = value[s];
    if (k > 0 && into.off[k] !== into.off[k - 1]) path.start[k] = 1;
  }
  return true;
}
