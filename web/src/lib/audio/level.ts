// Уровень голоса. Браузерное автоусиление, шумоподавление и (кроме «Без наушников»)
// эхоподавление при захвате выключены ради точной высоты, поэтому у тихого микрофона пение
// может не дотягивать до порога громкости детектора, и линия голоса рвётся.
//
// 1. Анализ: порог громкости детектора — прежний постоянный RMS 0.008, пока проверка микрофона
//    не замерила протяжную ноту певца (ANALYSIS.note ясных кадров подряд: чёткая высота в
//    диапазоне голоса, громче шума тракта). После замера порог — на 11 дБ ниже этой ноты, но
//    не выше прежнего и не ниже 0.002: усиление для распознавания от ×1 до ×4 (+12 дБ).
//    Громкий певец получает прежний порог. С началом попытки порог фиксируется и в песне не
//    меняется. Без замера (тишина, тихий тон без протяжной ноты, тренировка, дуэли) порог
//    прежний. Метод McLeod не зависит от масштаба сигнала, поэтому усиление равносильно
//    снижению порога; сам звук, запись и отправка на точную оценку не меняются.
// 2. Переслушивание: запись доводится до ровной громкости (усиление ×1…×8) с мягким
//    ограничителем пиков, чтобы тихий голос не терялся под минусом.

export const ANALYSIS = {
  /** Прежний постоянный порог RMS детектора: без замера и у громкого певца. */
  gate: 0.008,
  /** Нижняя граница порога: усиление не больше ×4. */
  minGate: 0.002,
  /** Порог как доля уровня замеренной ноты: −11 дБ. */
  ratio: 0.27,
  /** Кадр тише этого не нота (ниже шума тракта). */
  floor: 0.0015,
  /** Протяжная нота: ясных кадров подряд (кадр — 10 мс), 0.4 с. */
  note: 40,
};

/** Порог RMS попытки: без замеренной ноты — прежний, с ней — на 11 дБ ниже, в пределах [minGate, gate]. */
export function gateFor(note: number, o = ANALYSIS): number {
  if (!(note >= o.floor)) return o.gate;
  return Math.min(o.gate, Math.max(o.minGate, note * o.ratio));
}

/** Усиление для распознавания: во сколько раз порог ниже прежнего (×1…×4). */
export function analysisGain(gate: number, o = ANALYSIS): number {
  return o.gate / gate;
}

/** Замер протяжной ноты: медиана RMS последних note ясных кадров подряд; запоминается самая громкая. 0 — ноты не было. */
export function createNoteMeter(o = ANALYSIS) {
  let notes: number[] = [];
  let level = 0;
  return {
    update(rms: number, clear: boolean): number {
      if (!clear || rms < o.floor) {
        notes = [];
        return level;
      }
      notes.push(rms);
      if (notes.length > o.note) notes.shift();
      if (notes.length === o.note) {
        const sorted = [...notes].sort((a, b) => a - b);
        level = Math.max(level, sorted[Math.floor(sorted.length / 2)]);
      }
      return level;
    },
    /** Забыть набранные кадры (замер включили или выключили): нота не склеивается через перерыв. Уровень остаётся. */
    reset() {
      notes = [];
    },
    get level() {
      return level;
    },
  };
}

export const PLAYBACK = {
  /** Целевой уровень пения (RMS громких блоков): около −20 дБFS. */
  target: 0.1,
  /** Усиление записи при переслушивании: от ×1 (громкую не трогаем) до ×8 (+18 дБ). */
  maxGain: 8,
  /** Блок для оценки громкости, с. */
  block: 0.05,
  /** Блоки тише считаются паузой. */
  silence: 0.002,
  /** Перцентиль громкости среди непустых блоков: уровень пения без редких выкриков. */
  percentile: 0.9,
  /** Ограничитель: до knee звук не меняется, выше плавно подходит к ceiling. */
  knee: 0.6,
  ceiling: 0.95,
};

/** Во сколько раз поднять запись: громкость пения → цель, в пределах [1, maxGain]. */
export function playbackGain(samples: Float32Array, sampleRate: number, o = PLAYBACK): number {
  const size = Math.max(1, Math.round(o.block * sampleRate));
  const levels: number[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / size);
    if (rms >= o.silence) levels.push(rms);
  }
  if (!levels.length) return 1;
  levels.sort((a, b) => a - b);
  const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * o.percentile))];
  return Math.min(o.maxGain, Math.max(1, o.target / loud));
}

/** Мягкий ограничитель: непрерывен и с наклоном 1 на колене, никогда не выше ceiling. */
export function limit(x: number, o = PLAYBACK): number {
  const a = Math.abs(x);
  if (a <= o.knee) return x;
  const room = o.ceiling - o.knee;
  return Math.sign(x) * (o.knee + room * Math.tanh((a - o.knee) / room));
}

/** Копия записи с ровной громкостью для переслушивания. Исходная запись не меняется. */
export function normalizeRecording(samples: Float32Array, sampleRate: number, o = PLAYBACK): Float32Array<ArrayBuffer> {
  const gain = playbackGain(samples, sampleRate, o);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = limit(samples[i] * gain, o);
  return out;
}
