// Свой трек: полный файл не покидает устройство. На сервер уходит только выбранный отрывок
// 15–60 с и по 2 секунды до и после него (C2: WAV 44,1 кГц моно PCM16). Поля за краями файла
// заполняются тишиной, поэтому отрывок всегда начинается ровно на 2-й секунде.
import { toPcm16 } from "#lib/precise/uploader.ts";

export const TRACK_RATE = 44_100;
export const MARGIN_S = 2;
export const MIN_WINDOW_S = 15;
export const MAX_WINDOW_S = 60;
export const DEFAULT_WINDOW_S = 30;

/** Среднее каналов декодированного файла. */
export function mono(buffer: { numberOfChannels: number; length: number; getChannelData(channel: number): Float32Array }): Float32Array<ArrayBuffer> {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i];
  }
  if (buffer.numberOfChannels > 1) for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

/**
 * Отрывок по умолчанию: первое окно длиной 30 с (или весь файл, если он короче), чья громкость
 * не ниже 60-го перцентиля громкости секундных блоков. Если такого нет — самое громкое окно.
 */
export function suggestWindow(samples: Float32Array, length = DEFAULT_WINDOW_S): { start: number; length: number } {
  const count = Math.floor(samples.length / TRACK_RATE);
  const window = Math.min(length, count);
  if (window <= 0) return { start: 0, length: samples.length / TRACK_RATE };
  const power = new Float64Array(count);
  for (let b = 0; b < count; b++) {
    let sum = 0;
    for (let i = b * TRACK_RATE; i < (b + 1) * TRACK_RATE; i++) sum += samples[i] * samples[i];
    power[b] = sum / TRACK_RATE;
  }
  const threshold = Float64Array.from(power).sort()[Math.floor(0.6 * count)];
  let sum = 0;
  for (let b = 0; b < window; b++) sum += power[b];
  let best = 0;
  let bestSum = sum;
  for (let start = 0; start + window <= count; start++) {
    if (start > 0) sum += power[start + window - 1] - power[start - 1];
    // Ровная громкость не должна проигрывать перцентилю из-за погрешности сложения.
    if (sum / window >= threshold * (1 - 1e-9)) return { start, length: window };
    if (sum > bestSum) [best, bestSum] = [start, sum];
  }
  return { start: best, length: window };
}

/** WAV 44,1 кГц моно PCM16: окно [start, start + length) с полями по MARGIN_S секунд. */
export function encodeWav(samples: Float32Array, start: number, length: number): Uint8Array<ArrayBuffer> {
  const first = Math.round((start - MARGIN_S) * TRACK_RATE);
  const count = Math.round((length + 2 * MARGIN_S) * TRACK_RATE);
  const section = new Float32Array(count);
  const from = Math.max(0, first);
  const to = Math.min(samples.length, first + count);
  if (to > from) section.set(samples.subarray(from, to), from - first);
  const pcm = toPcm16(section);
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TRACK_RATE, true);
  view.setUint32(28, TRACK_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + 2 * i, pcm[i], true);
  return out;
}
