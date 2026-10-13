import { useEffect, useRef, useState } from "react";

export function useReducedMotion() {
  const [reduce, setReduce] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduce(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduce;
}
export function palette(canvas: HTMLCanvasElement) {
  const css = getComputedStyle(canvas);
  const read = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return {
    bg: read("bg"),
    surface: read("surface"),
    grid: read("grid"),
    muted: read("muted"),
    echo: read("echo"),
    ghost: read("ghost"),
    amber: read("amber"),
    pink: read("pink"),
  };
}
// Coalesce incoming pitch updates into one UI-thread draw per animation frame.
// Resizing is independent of transport, so a paused chart stays crisp too.
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef(draw);
  latest.current = draw;
  const request = useRef<() => void>(() => {});
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (!w || !h) return;
      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      latest.current(ctx, w, h);
    };
    request.current = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const observer = new ResizeObserver(request.current);
    observer.observe(canvas);
    window.addEventListener("resize", request.current);
    request.current();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", request.current);
      cancelAnimationFrame(raf);
      request.current = () => {};
    };
  }, []);
  useEffect(() => {
    request.current();
  });
  return ref;
}
