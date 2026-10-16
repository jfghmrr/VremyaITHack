// Асинхронный доступ к ядру оценки через Web Worker.
import type { CorrectionPoint, Outcome, PitchFrame, ScoreResult, Song } from "./types";
import type { Request, Response } from "./protocol";

type Body = Request extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

let worker: Worker | null = null;
let next = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Время последнего расчёта в воркере, мс — для протокола производительности. */
export const timings: { last: number; init?: number } = { last: 0 };

function ensure() {
  if (!worker) {
    const started = performance.now();
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Response>) => {
      timings.init ??= performance.now() - started;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) {
        timings.last = data.ms;
        p.resolve(data.value);
      } else p.reject(new Error(data.error));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error("Модуль оценки не загрузился. Обнови страницу."));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call<T>(body: Body): Promise<T> {
  const id = next++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    // Реактивные прокси Svelte нельзя передать в Worker: отправляется их снимок.
    ensure().postMessage({ ...$state.snapshot(body), id });
  });
}

/** Прогрев: загрузка WASM до того, как понадобится результат. */
export const warmUp = () => call<PitchFrame[]>({ kind: "canonical", frames: [], duration: 0.05 });

export const score = (frames: PitchFrame[], song: Song) => call<ScoreResult>({ kind: "score", frames, song });

export const canonical = (frames: PitchFrame[], duration: number) =>
  call<PitchFrame[]>({ kind: "canonical", frames, duration });

export const correction = (frames: PitchFrame[], song: Song, result: ScoreResult) =>
  call<CorrectionPoint[]>({ kind: "correction", frames, song, result });

/** Исход для первого участника по правилу ядра (ничья при равенстве до двух знаков). */
export const outcome = (a: number, b: number) => call<Outcome>({ kind: "outcome", a, b });

export const ALGORITHM_VERSION = 1;
