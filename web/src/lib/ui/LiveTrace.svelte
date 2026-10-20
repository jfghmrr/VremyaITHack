<script lang="ts">
  // Живая линия голоса при проверке микрофона: последние шесть секунд.
  import { css, paint } from "./canvas";
  import { VOICE, voiceParts } from "./voice-line";

  const LIVE = { ...VOICE, stepMax: 0.05, bridgeS: 0.1 };

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
    // Как на сцене (voice-line.ts): лёгкое сглаживание и мостики через короткие провалы. Время
    // кадра здесь — момент его прихода из Worker, поэтому шаг между кадрами допускается шире.
    ctx.beginPath();
    for (const part of voiceParts(points.map((p) => ({ t: p.at, midi: p.midi })), now - 6, Infinity, LIVE)) {
      part.forEach((p, k) => {
        const x = w - 12 - ((now - p.t) / 6) * (w - 24);
        const y = h / 2 - (p.m - center) * (h / 16);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
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
