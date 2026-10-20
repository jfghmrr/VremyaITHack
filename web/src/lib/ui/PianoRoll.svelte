<script lang="ts">
  // Широкий piano roll сцены. Рисует эталон (графит), свой голос (малиновый) и соперника
  // (индиго, пунктир). Неточность — тоньше и прозрачнее, ошибка — штрих: не только цветом.
  import type { PitchFrame, Song } from "#lib/scoring/types.ts";
  import { css, paint } from "./canvas";
  import { displayCurve, referencePath, stageSpan } from "./reference-line";
  import { createVoicePath, RIVAL_LINE, VOICE, voicePath } from "./voice-line";
  import { createStageKey, fixStageKey, seedStageKey, stageKeyAt, stageOffsets, updateStageKey, type StageKey } from "./stage-key";
  import { strokeRuns } from "./stroke";

  let {
    song,
    frames,
    time,
    rival = null,
    rivalShift = null,
    ownShift = null,
    span = null,
    label = "Мелодия: эталон серым, твой голос малиновым",
  }: {
    song: Song;
    /** Кадры читаются на каждом кадре анимации, без реактивных обновлений. */
    frames: () => PitchFrame[];
    time: () => number;
    rival?: PitchFrame[] | null;
    /**
     * Сдвиг тональности линии соперника. Число — постоянный (призрак: сдвиг из оценки его попытки);
     * null — оценивается по самой кривой во время пения, как у своей линии (живая дуэль, «Вместе»).
     */
    rivalShift?: number | null;
    /**
     * Начальный сдвиг своей линии, пока он не оценён по пению (тренировка: сдвиг тональности из
     * оценки попытки), — линия видна с первой ноты. Без значения линия появляется через ~1 с голоса.
     */
    ownShift?: number | null;
    /** Окно в секундах; без значения — по ширине графика (stageSpan: ~55 px/с, 6–9 с). */
    span?: number | null;
    label?: string;
  } = $props();

  // Геометрия эталона считается один раз на песню в обычных массивах. Раньше draw() на каждом
  // кадре читал $derived (lo, hi) сотни раз вне реактивного контекста, и каждое чтение заново
  // проверяло зависимость от ~1400 элементов прокси song.f0_midi: 84 % времени кадра на
  // телефоне (perf-audit R1).
  let geo: { src: Song; f0: (number | null)[]; line: (number | null)[]; lo: number; hi: number; hop: number } | null = null;
  function geometry(s: Song) {
    if (geo?.src !== s) {
      const f0 = $state.snapshot(s.f0_midi) as (number | null)[];
      const hop = s.hop_ms / 1000;
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of f0) {
        if (m === null) continue;
        lo = Math.min(lo, m);
        hi = Math.max(hi, m);
      }
      if (lo > hi) [lo, hi] = [60, 60];
      geo = { src: s, f0, line: displayCurve(f0, hop, $state.snapshot(s.phrases ?? [])), lo: lo - 4, hi: hi + 4, hop };
    }
    return geo;
  }

  // Сдвиг тональности для картинки (stage-key.ts): целые полутоны, меняется редко и только для
  // новых кадров; уже нарисованная точка остаётся на своей высоте до конца попытки. Свои кадры
  // идут через 10 мс, кривая соперника — через 50 мс.
  const ownKey = createStageKey(0.01);
  const rivalKey = createStageKey(0.05);

  const NO_DASH: number[] = [];
  const DASH_ERROR = [3, 5];
  const DASH_RIVAL = [6, 6];
  type LineMemo = {
    points: PitchFrame[] | null;
    length: number;
    start: number;
    stop: number;
    first: number | undefined;
    last: number | undefined;
    version: number;
    path: ReturnType<typeof createVoicePath>;
    /** Сдвиг каждой точки path (stageOffsets); ready = false — сдвига ещё нет, линия не рисуется. */
    off: Float64Array;
    ready: boolean;
  };
  const lineCache = (): LineMemo => ({ points: null, length: -1, start: -1, stop: -1, first: undefined, last: undefined, version: -1, path: createVoicePath(), off: new Float64Array(1024), ready: false });
  const ownLine = lineCache();
  const rivalLine = lineCache();

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const el = ctx.canvas;
    const own = frames();
    const { f0, line: refLine, lo, hi, hop } = geometry(song);
    const others = rival;
    const visible = span ?? stageSpan(w);
    const c = {
      ref: css(el, "stage-reference"),
      self: css(el, "stage-accent"),
      rival: css(el, "stage-rival"),
      grid: css(el, "stage-line"),
      ink: css(el, "stage-ink-2"),
    };
    const now = Math.max(0, time());
    const left = now - visible * 0.25;
    const x = (t: number) => ((t - left) / visible) * w;
    const y = (m: number) => h - 32 - ((m - lo) / (hi - lo)) * (h - 64);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.grid;
    ctx.globalAlpha = 0.5;
    for (let m = Math.ceil(lo); m <= hi; m += 2) {
      ctx.beginPath();
      ctx.moveTo(0, y(m));
      ctx.lineTo(w, y(m));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ink;
    ctx.font = "500 12px 'Golos Text', sans-serif";
    for (let t = Math.max(0, Math.ceil(left)); t < left + visible; t++) ctx.fillText(`${t} с`, x(t) + 6, h - 10);

    // Эталон: широкая линия по сглаженной кривой высоты с мостиками через короткие паузы внутри
    // фразы; ноты синтезированного эталона — ровные полосы piano roll (reference-line.ts).
    // Скругление стыков: на изгибах живого голоса нет шипов.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = c.ref;
    ctx.lineWidth = 10;
    for (const part of referencePath(refLine, hop, left, visible, w, ctx.lineWidth / 2)) {
      ctx.beginPath();
      ctx.moveTo(part[0].x, y(part[0].m));
      for (let k = 1; k < part.length; k++) ctx.lineTo(part[k].x, y(part[k].m));
      ctx.stroke();
    }

    // Сдвиг тональности только для картинки: новые кадры дополняют оценку (stage-key.ts).
    if (ownShift != null) seedStageKey(ownKey, ownShift);
    updateStageKey(ownKey, own, f0, hop);
    if (others) {
      if (rivalShift != null) fixStageKey(rivalKey, rivalShift);
      else updateStageKey(rivalKey, others, f0, hop);
    }

    // Стиль отрезка: 0 точно — сплошная, 1 неточно — тоньше и прозрачнее, 2 ошибка — штрих,
    // 3 соперник — пунктир.
    const apply = (kind: number, x0: number) => {
      ctx.setLineDash(kind === 3 ? DASH_RIVAL : kind === 2 ? DASH_ERROR : NO_DASH);
      ctx.lineWidth = kind === 3 ? 3 : kind === 1 ? 2.5 : 4;
      ctx.globalAlpha = kind === 3 ? 0.9 : kind === 1 ? 0.6 : 1;
      ctx.lineDashOffset = -x0;
    };
    const line = (points: PitchFrame[], key: StageKey, color: string, mode: "self" | "rival") => {
      ctx.strokeStyle = color;
      // Бинарный поиск начала окна: длина уже спетой песни не замедляет график.
      let start = 0, end = points.length;
      while (start < end) {
        const mid = (start + end) >>> 1;
        if (points[mid].t < left - 0.3) start = mid + 1;
        else end = mid;
      }
      let stop = start;
      while (stop < points.length && points[stop].t <= left + visible) stop++;
      // Только картинка (voice-line.ts): лёгкое сглаживание и мостики через короткие провалы
      // распознавания внутри ноты; паузы остаются разрывами. Оценка получает сырые кадры.
      // Точки — в переиспользуемых буферах; пока кадры в окне те же (пауза, кадр анимации без
      // нового кадра детектора) и сдвиг не менялся, линия не пересчитывается. Сдвиг каждой точки
      // — тот, что действовал, когда пришёл её кадр; на смене сдвига линия разрывается.
      const cache = mode === "rival" ? rivalLine : ownLine;
      if (cache.points !== points || cache.length !== points.length || cache.start !== start || cache.stop !== stop || cache.first !== points[start]?.t || cache.last !== points[stop - 1]?.t || cache.version !== key.version) {
        voicePath(cache.path, points, start, stop, -Infinity, Infinity, mode === "rival" ? RIVAL_LINE : VOICE);
        cache.ready = stageOffsets(key, cache.path, cache);
        cache.version = key.version;
        cache.points = points;
        cache.length = points.length;
        cache.start = start;
        cache.stop = stop;
        cache.first = points[start]?.t;
        cache.last = points[stop - 1]?.t;
      }
      if (!cache.ready) return;
      const p = cache.path;
      const off = cache.off;
      // Подряд идущие отрезки одного стиля — одна линия (stroke.ts). Ошибка отрезка считается с
      // тем же сдвигом, с которым нарисована его точка: цвет совпадает с местом на графике.
      strokeRuns(
        ctx,
        p.n,
        (k) => x(p.t[k]),
        (k) => y(p.m[k] - off[k]),
        (k) => p.start[k] === 1,
        (k) => {
          if (mode === "rival") return 3;
          const r = f0[Math.round(p.t[k] / hop)];
          const error = r == null ? 0 : Math.abs(p.m[k] - off[k] - r);
          return error >= 1.5 ? 2 : error >= 0.6 ? 1 : 0;
        },
        apply,
      );
      ctx.setLineDash(NO_DASH);
      ctx.globalAlpha = 1;
    };
    if (others) line(others, rivalKey, c.rival, "rival");
    line(own, ownKey, c.self, "self");

    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(now), 12);
    ctx.lineTo(x(now), h - 32);
    ctx.stroke();
    const latest = own.at(-1);
    const at = latest ? stageKeyAt(ownKey, latest.t) : NaN;
    if (latest?.midi != null && now - latest.t < 0.3 && Number.isFinite(at)) {
      ctx.fillStyle = c.self;
      ctx.beginPath();
      ctx.arc(x(latest.t), y(latest.midi - at), 6, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
</script>

<div class="canvas" role="img" aria-label={label}><canvas use:paint={{ draw, live: true }} aria-hidden="true"></canvas></div>

<style>
  .canvas,
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
