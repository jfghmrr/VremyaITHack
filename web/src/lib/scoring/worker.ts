// Web Worker оценки: WASM-ядро считает вне потока интерфейса.
import { canonicalCurve, correctionCurve, initWasm, outcome, scorePerformance } from "./core";
import type { Request, Response } from "./protocol";

const ready = initWasm();

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  await ready;
  let reply: Response;
  try {
    const started = performance.now();
    const value =
      data.kind === "score"
        ? scorePerformance(data.frames, data.song)
        : data.kind === "canonical"
          ? canonicalCurve(data.frames, data.duration)
          : data.kind === "outcome"
            ? outcome(data.a, data.b)
            : correctionCurve(data.frames, data.song, data.result);
    reply = { id: data.id, ok: true, value, ms: performance.now() - started };
  } catch (e) {
    reply = { id: data.id, ok: false, error: String(e) };
  }
  (self as unknown as Worker).postMessage(reply);
};
