// Свой трек: на сервер уходит только выбранный отрывок с полями по 2 секунды,
// WAV 44,1 кГц моно PCM16; отрывок по умолчанию — первое громкое 30-секундное окно.
import { expect, it } from "vitest";
import { MARGIN_S, TRACK_RATE, encodeWav, mono, suggestWindow } from "../src/lib/tracks/wav";

const RATE = TRACK_RATE;
const ascii = (bytes: Uint8Array, at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
const pcmOf = (wav: Uint8Array) => new Int16Array(wav.slice(44).buffer);

/** Сигнал из секундных блоков одинаковой громкости: amplitudes[k] — амплитуда k-й секунды. */
function blocks(amplitudes: number[]) {
  const second = Float32Array.from({ length: RATE }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / RATE));
  const out = new Float32Array(amplitudes.length * RATE);
  amplitudes.forEach((a, k) => out.set(second.map((v) => v * a), k * RATE));
  return out;
}

it("WAV: заголовок RIFF/WAVE, PCM 16 бит, моно, 44,1 кГц", () => {
  const wav = encodeWav(new Float32Array(RATE * 40).fill(0.25), 10, 30);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  expect(MARGIN_S).toBe(2);
  expect(ascii(wav, 0, 4)).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  expect(ascii(wav, 8, 4)).toBe("WAVE");
  expect(ascii(wav, 12, 4)).toBe("fmt ");
  expect(view.getUint32(16, true)).toBe(16);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(44100);
  expect(view.getUint32(28, true)).toBe(88200);
  expect(view.getUint16(32, true)).toBe(2);
  expect(view.getUint16(34, true)).toBe(16);
  expect(ascii(wav, 36, 4)).toBe("data");
  expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
  expect(pcmOf(wav)[RATE * 5]).toBe(Math.round(0.25 * 32767));
});

it("WAV: длина = (окно + 4 с) × 44100 × 2 + 44 для любого окна 15–60 с", () => {
  const samples = new Float32Array(RATE * 90);
  for (const [start, length] of [
    [10, 30],
    [0, 15],
    [25, 60],
    [80, 15],
  ])
    expect(encodeWav(samples, start, length).byteLength).toBe((length + 4) * 44100 * 2 + 44);
});

it("WAV: отрывок начинается ровно через 2 с; поля за краями файла — тишина", () => {
  const samples = Float32Array.from({ length: RATE * 20 }, (_, i) => 0.1 + (i % 100) / 400);
  const head = pcmOf(encodeWav(samples, 0, 15));
  expect(head.subarray(0, 2 * RATE).every((v) => v === 0)).toBe(true);
  expect(head[2 * RATE]).toBe(Math.round(samples[0] * 32767));
  expect(head[(2 + 15) * RATE + 7]).toBe(Math.round(samples[15 * RATE + 7] * 32767));
  const tail = pcmOf(encodeWav(samples, 5, 15));
  expect(tail[0]).toBe(Math.round(samples[3 * RATE] * 32767));
  expect(tail[(2 + 15) * RATE - 1]).toBe(Math.round(samples[20 * RATE - 1] * 32767));
  expect(tail.subarray((2 + 15) * RATE).every((v) => v === 0)).toBe(true);
});

it("моно: среднее каналов", () => {
  const left = Float32Array.of(1, 0.5, -1);
  const right = Float32Array.of(0, 0.5, 1);
  const buffer = { numberOfChannels: 2, length: 3, getChannelData: (c: number) => (c ? right : left) };
  expect(Array.from(mono(buffer))).toEqual([0.5, 0.5, 0]);
});

it("отрывок по умолчанию: первое 30-секундное окно не тише 60-го перцентиля громкости", () => {
  // Тихое вступление 20 с, затем громкая часть.
  expect(suggestWindow(blocks([...Array(20).fill(0.02), ...Array(60).fill(0.5)]))).toEqual({ start: 20, length: 30 });
  // Громкая часть до самого конца: окно заканчивается вместе с файлом.
  expect(suggestWindow(blocks([...Array(10).fill(0.02), ...Array(30).fill(0.5)]))).toEqual({ start: 10, length: 30 });
  // Ровная громкость: с начала.
  expect(suggestWindow(blocks(Array(50).fill(0.3)))).toEqual({ start: 0, length: 30 });
  // Файл короче 30 с: весь файл.
  expect(suggestWindow(blocks(Array(20).fill(0.3)))).toEqual({ start: 0, length: 20 });
  // Вступление, куплет, громкий припев: окно начинается не в тишине вступления.
  const { start } = suggestWindow(blocks([...Array(20).fill(0.02), ...Array(20).fill(0.2), ...Array(30).fill(0.5), ...Array(10).fill(0.05)]));
  expect(start).toBeGreaterThanOrEqual(10);
  expect(start).toBeLessThanOrEqual(40);
});
