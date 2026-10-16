// Синхронные вызовы WASM-ядра. Модуль должен быть инициализирован через ready()
// (в браузере) или initSync (в тестах). Вызывать из Web Worker: оценка занимает
// десятки миллисекунд и не должна блокировать интерфейс.
import * as wasm from "#lib/wasm/scoring.js";
import type { CorrectionPoint, Outcome, PitchFrame, ScoreResult, Song } from "./types";

// Прежний скоринг отбрасывал кадры с нечисловыми t или midi. JSON превращает NaN в null,
// что изменило бы смысл кадра, поэтому фильтр применяется до сериализации.
const finite = (frames: PitchFrame[]) =>
  frames
    .filter((f) => Number.isFinite(f.t) && (f.midi === null || Number.isFinite(f.midi)))
    .map((f) => ({ t: f.t, midi: f.midi }));

const songJson = new WeakMap<Song, string>();
function songText(song: Song) {
  let text = songJson.get(song);
  if (!text) {
    text = JSON.stringify({
      hop_ms: song.hop_ms,
      duration_s: song.duration_s,
      f0_midi: song.f0_midi,
      phrases: song.phrases,
    });
    songJson.set(song, text);
  }
  return text;
}

export const algorithmVersion = () => wasm.algorithmVersion();

export function scorePerformance(frames: PitchFrame[], song: Song): ScoreResult {
  return JSON.parse(wasm.score(JSON.stringify(finite(frames)), songText(song)));
}

export function canonicalCurve(frames: PitchFrame[], duration: number): PitchFrame[] {
  return JSON.parse(wasm.canonicalCurve(JSON.stringify(finite(frames)), duration));
}

export function correctionCurve(frames: PitchFrame[], song: Song, result: ScoreResult): CorrectionPoint[] {
  return JSON.parse(
    wasm.correctionCurve(JSON.stringify(finite(frames)), songText(song), JSON.stringify(result)),
  );
}

export const outcome = (a: number, b: number) => wasm.outcome(a, b) as Outcome;

export const initWasm = (input?: Parameters<typeof wasm.default>[0]) => wasm.default(input);
export const initWasmSync = (module: BufferSource) => wasm.initSync({ module });
