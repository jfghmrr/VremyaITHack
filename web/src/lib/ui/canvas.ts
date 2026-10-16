// Общие утилиты Canvas 2D: перерисовка в requestAnimationFrame, независимая от
// реактивного дерева Svelte, чёткость на HiDPI и цвета из CSS-переменных.
const palette = new WeakMap<Element, { at: number; values: Map<string, string>; style: CSSStyleDeclaration }>();
export function css(el: Element, name: string) {
  const now = performance.now();
  let entry = palette.get(el);
  if (!entry || now - entry.at > 500) {
    entry = { at: now, values: new Map(), style: getComputedStyle(el) };
    palette.set(el, entry);
  }
  let value = entry.values.get(name);
  if (value === undefined) {
    value = entry.style.getPropertyValue(`--${name}`).trim();
    entry.values.set(name, value);
  }
  return value;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Svelte-действие: вызывает draw на каждом кадре (или однократно при static). */
export function paint(
  canvas: HTMLCanvasElement,
  params: { draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; live?: boolean; deps?: unknown },
) {
  let current = params;
  let raf = 0;
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  const frame = () => {
    raf = 0;
    if (document.hidden) return;
    const dpr = devicePixelRatio || 1;
    if (w && h && ctx) {
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      current.draw(ctx, w, h);
    }
    if (current.live) schedule();
  };
  const schedule = () => {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  };
  // Размеры читаем при изменении, а не вызываем layout на каждом аудиокадре.
  const observer = new ResizeObserver((entries) => {
    w = entries[0].contentRect.width;
    h = entries[0].contentRect.height;
    palette.delete(canvas);
    schedule();
  });
  observer.observe(canvas);
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return {
    update(next: typeof params) {
      current = next;
      schedule();
    },
    destroy() {
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      cancelAnimationFrame(raf);
      palette.delete(canvas);
    },
  };
}

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const a = [...xs].sort((a, b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
