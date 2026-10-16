<script lang="ts">
  // Живая линия голоса при проверке микрофона: последние шесть секунд.
  import { css, paint } from "./canvas";

  let { points }: { points: { at: number; midi: number | null }[] } = $props();

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const el = ctx.canvas;
    const now = performance.now() / 1000;
    ctx.strokeStyle = css(el, "line");
    ctx.lineWidth = 1;
    for (let y = h / 4; y < h; y += h / 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const voiced = points.filter((p) => p.midi !== null && now - p.at < 6);
    const center = voiced.length ? voiced.reduce((a, p) => a + p.midi!, 0) / voiced.length : 60;
    ctx.strokeStyle = css(el, "accent");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    let last = 0;
    for (const p of points) {
      if (p.midi === null || now - p.at > 6) {
        last = 0;
        continue;
      }
      const x = w - 12 - ((now - p.at) / 6) * (w - 24);
      const y = h / 2 - (p.midi - center) * (h / 16);
      if (last && p.at - last < 0.15) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      last = p.at;
    }
    ctx.stroke();
  }
</script>

<div class="canvas" role="img" aria-label="Живая линия голоса за последние шесть секунд"><canvas use:paint={{ draw, live: true }} aria-hidden="true"></canvas></div>

<style>
  .canvas,
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
