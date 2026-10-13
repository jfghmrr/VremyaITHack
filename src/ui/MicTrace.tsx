import { useEffect, useRef } from "react";
import type { PitchFrame } from "../types";
import { palette, useCanvas, useReducedMotion } from "./canvas";
export function MicTrace({
  live,
  ready,
}: {
  live: PitchFrame;
  ready: boolean;
}) {
  const points = useRef<{ t: number; midi: number | null }[]>([]);
  const reduce = useReducedMotion();
  useEffect(() => {
    points.current = [];
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const t = performance.now() / 1000;
    points.current.push({ t, midi: live.midi });
    points.current = points.current.filter((p) => p.t > t - 6);
  }, [live, ready]);
  const ref = useCanvas((ctx, w, h) => {
    const colors = palette(ctx.canvas);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    for (let y = 24; y < h; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const now = performance.now() / 1000;
    const voiced = points.current.filter((p) => p.midi !== null);
    const center = voiced.length
      ? voiced.reduce((a, p) => a + p.midi!, 0) / voiced.length
      : 60;
    const draw = (dy: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colors.echo;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let last = 0;
      for (const p of points.current) {
        if (p.midi === null) {
          last = 0;
          continue;
        }
        const x = w - 36 - ((now - p.t) / 6) * (w - 72),
          y = h / 2 - (p.midi - center) * 8 + dy;
        if (last && p.t - last < 0.15) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        last = p.t;
      }
      ctx.stroke();
    };
    if (!reduce) {
      draw(8, 0.16);
      draw(16, 0.07);
    }
    draw(0, 1);
    ctx.globalAlpha = 1;
  });
  return (
    <div className="mic-trace">
      <canvas
        ref={ref}
        role="img"
        aria-label="Живая линия голоса за последние шесть секунд"
      />
      <span>
        {ready
          ? "Спой любую ноту, чтобы проверить"
          : "Здесь появится линия твоего голоса"}
      </span>
    </div>
  );
}
