<script lang="ts">
  // Вся попытка на одной линии: ориентир (графит), голос (малиновый: точно — сплошная,
  // неточно — тонкая, ошибка — штрих), соперник (индиго, пунктир). В режиме «ориентир»
  // линия голоса плавно переходит к идеальной высоте в твоей тональности.
  import { css, paint, reducedMotion } from "./canvas";
  import { referencePath } from "./reference-line";
  import type { TracePoint } from "./series";
  import { strokeRuns } from "./stroke";
  import { createVoicePath, VOICE, voicePath } from "./voice-line";

  const NO_DASH: number[] = [];
  const DASH_ERROR = [3, 4];
  const DASH_RIVAL = [5, 5];
  const userPath = createVoicePath();
  const rivalPath = createVoicePath();
  // Ряды для рисования считаются один раз на данные (во время анимации «Ориентира» data та же).
  let cached: { data: TracePoint[]; line: (number | null)[]; user: { t: number; midi: number | null }[]; rival: { t: number; midi: number | null }[]; hasRival: boolean } | null = null;
  function seriesOf(data: TracePoint[]) {
    if (cached?.data !== data)
      cached = {
        data,
        line: data.map((p) => p.line ?? p.target),
        user: data.map((p) => ({ t: p.t, midi: p.user })),
        rival: data.map((p) => ({ t: p.t, midi: p.rival })),
        hasRival: data.some((p) => p.rival !== null),
      };
    return cached;
  }

  let {
    data,
    duration,
    ideal = false,
    window: highlight = null,
    label,
  }: { data: TracePoint[]; duration: number; ideal?: boolean; window?: [number, number] | null; label: string } = $props();

  let mix = 0;
  let target = $derived(ideal ? 1 : 0);
  let animating = $state(false);

  $effect(() => {
    const to = target;
    const from = mix;
    const start = performance.now();
    animating = true;
    let raf = 0;
    const step = (now: number) => {
      const t = reducedMotion() ? 1 : Math.min(1, (now - start) / 500);
      mix = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) raf = requestAnimationFrame(step);
      else animating = false;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const el = ctx.canvas;
    const c = { ref: css(el, "reference"), self: css(el, "accent"), rival: css(el, "rival"), grid: css(el, "line"), soft: css(el, "accent-soft") };
    const pitches = data.flatMap((p) => [p.target, p.user, p.rival].filter((m): m is number => m !== null));
    const lo = pitches.length ? Math.min(...pitches) - 1 : 48;
    const hi = pitches.length ? Math.max(...pitches) + 1 : 72;
    const x = (t: number) => 4 + (t / duration) * (w - 8);
    const y = (m: number) => h - 12 - ((m - lo) / Math.max(4, hi - lo)) * (h - 24);
    if (highlight) {
      ctx.fillStyle = c.soft;
      ctx.fillRect(x(highlight[0]), 0, x(highlight[1]) - x(highlight[0]), h);
    }
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (let s = 5; s < duration; s += 5) {
      ctx.beginPath();
      ctx.moveTo(x(s), 0);
      ctx.lineTo(x(s), h);
      ctx.stroke();
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Ориентир — как на сцене: части referencePath (reference-line.ts: разрыв только на паузе или
    // скачке от JUMP полутона, концы внутрь на радиус круглого конца, без частей нулевой длины),
    // каждая — одна линия. Раньше каждый отрезок 20 мс обводился отдельно с прозрачностью, и
    // круглые концы, накладываясь, давали серые бусины вместо линии.
    const step = data.length > 1 ? data[1].t - data[0].t : 0.02;
    const series = seriesOf(data);
    ctx.strokeStyle = c.ref;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.45;
    for (const part of referencePath(series.line, step, 0, duration, w - 8, ctx.lineWidth / 2)) {
      ctx.beginPath();
      ctx.moveTo(4 + part[0].x, y(part[0].m));
      for (let k = 1; k < part.length; k++) ctx.lineTo(4 + part[k].x, y(part[k].m));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Голос и соперник: лёгкое сглаживание и мостики через короткие провалы (voice-line.ts),
    // только для картинки; подряд идущие отрезки одного стиля — одна линия (stroke.ts).
    const at = (t: number) => data[Math.min(data.length - 1, Math.max(0, Math.round((t - (data[0]?.t ?? 0)) / step)))];
    const voice = (kind: "user" | "rival") => {
      const p = voicePath(kind === "user" ? userPath : rivalPath, series[kind], 0, data.length, -Infinity, Infinity, { ...VOICE, stepMax: step * 1.5, smooth: kind === "user" });
      // «Ориентир»: линия голоса плавно переходит к идеальной высоте (mix от 0 до 1).
      const shown = (k: number) => {
        const target = kind === "user" ? (at(p.t[k])?.target ?? null) : null;
        return target !== null ? p.m[k] + (target - p.m[k]) * mix : p.m[k];
      };
      ctx.strokeStyle = kind === "user" ? c.self : c.rival;
      strokeRuns(
        ctx,
        p.n,
        (k) => x(p.t[k]),
        (k) => y(shown(k)),
        (k) => p.start[k] === 1,
        (k) => {
          if (kind === "rival") return 3;
          const target = at(p.t[k])?.target ?? null;
          const error = target !== null ? Math.abs(shown(k) - target) : 0;
          return error >= 1.5 ? 2 : error >= 0.6 ? 1 : 0;
        },
        (style, x0) => {
          ctx.globalAlpha = style === 3 ? 0.9 : style === 1 ? 0.55 : 1;
          ctx.lineWidth = style === 3 ? 2 : style === 2 ? 3 : style === 1 ? 1.75 : 2.5;
          ctx.setLineDash(style === 3 ? DASH_RIVAL : style === 2 ? DASH_ERROR : NO_DASH);
          ctx.lineDashOffset = -x0;
        },
      );
      ctx.globalAlpha = 1;
      ctx.setLineDash(NO_DASH);
    };
    voice("user");
    // Пунктир соперника или призрака — поверх своей линии: где линии совпадают, видны обе
    // (в просветах пунктира — своя). Раньше он рисовался под своей и при точном совпадении пропадал.
    if (series.hasRival) voice("rival");
  }
</script>

<div class="canvas" role="img" aria-label={label}><canvas use:paint={{ draw, live: animating, deps: [data, highlight, duration] }} aria-hidden="true"></canvas></div>

<style>
  .canvas,
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
