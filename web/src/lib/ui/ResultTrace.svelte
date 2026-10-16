<script lang="ts">
  // Вся попытка на одной линии: ориентир (графит), голос (малиновый: точно — сплошная,
  // неточно — тонкая, ошибка — штрих), соперник (индиго, пунктир). В режиме «ориентир»
  // линия голоса плавно переходит к идеальной высоте в твоей тональности.
  import { css, paint, reducedMotion } from "./canvas";
  import type { TracePoint } from "./series";

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
    const line = (kind: "target" | "user" | "rival") => {
      let prev: { x: number; y: number } | null = null;
      for (const p of data) {
        const n = p[kind];
        if (n === null) {
          prev = null;
          continue;
        }
        const note = kind === "user" && p.target !== null ? n + (p.target - n) * mix : n;
        const point = { x: x(p.t), y: y(note) };
        const error = kind === "user" && p.target !== null ? Math.abs(note - p.target) : 0;
        if (kind === "target") {
          ctx.strokeStyle = c.ref;
          ctx.lineWidth = 6;
          ctx.globalAlpha = 0.45;
          ctx.setLineDash([]);
        } else if (kind === "rival") {
          ctx.strokeStyle = c.rival;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.9;
          ctx.setLineDash([5, 5]);
        } else {
          ctx.strokeStyle = c.self;
          ctx.globalAlpha = error >= 0.6 && error < 1.5 ? 0.55 : 1;
          ctx.lineWidth = error >= 1.5 ? 3 : error >= 0.6 ? 1.75 : 2.5;
          ctx.setLineDash(error >= 1.5 ? [3, 4] : []);
        }
        if (prev) {
          ctx.lineDashOffset = -prev.x;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
        }
        prev = point;
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    };
    line("target");
    if (data.some((p) => p.rival !== null)) line("rival");
    line("user");
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
