// Длительность своего трека по заголовку файла, без раскодирования: длинный файл отклоняется
// до decodeAudioData, даже если браузер не сообщил длительность через <audio>.
import { expect, it } from "vitest";
import { headerDuration } from "../src/lib/tracks/header";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32le = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
const u32be = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16le = (v: number) => [v & 255, v >>> 8];
const blob = (...parts: (number[] | Uint8Array<ArrayBuffer>)[]) => new Blob(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));

function wavHeader(byteRate: number, dataBytes: number, extra: number[] = []) {
  const fmt = [...ascii("fmt "), ...u32le(16), ...u16le(1), ...u16le(1), ...u32le(byteRate), ...u32le(byteRate), ...u16le(1), ...u16le(8)];
  return [...ascii("RIFF"), ...u32le(36 + dataBytes), ...ascii("WAVE"), ...extra, ...fmt, ...ascii("data"), ...u32le(dataBytes)];
}

it("WAV: длина данных / байт в секунду; дополнительные блоки пропускаются; обрезанный файл — по фактическому размеру", async () => {
  expect(await headerDuration(blob(wavHeader(8000, 8000 * 660), new Uint8Array(8000 * 660)))).toEqual({ seconds: 660, exact: true });
  const list = [...ascii("LIST"), ...u32le(5), ...ascii("INFOx"), 0];
  expect(await headerDuration(blob(wavHeader(8000, 8000 * 20, list), new Uint8Array(8000 * 20)))).toEqual({ seconds: 20, exact: true });
  // Заголовок обещает три часа, а данных на 30 секунд.
  expect(await headerDuration(blob(wavHeader(8000, 8000 * 10800), new Uint8Array(8000 * 30)))).toEqual({ seconds: 30, exact: true });
  // Потоковая запись без размера данных.
  expect(await headerDuration(blob(wavHeader(8000, 0xffffffff), new Uint8Array(8000 * 40)))).toEqual({ seconds: 40, exact: true });
});

/** Кадр MPEG-1 Layer III 128 кбит/с, 44,1 кГц, стерео: 417 байт. */
const frame = (body: number[] = []) => {
  const out = new Uint8Array(417);
  out.set([0xff, 0xfb, 0x90, 0x00, ...body]);
  return out;
};

it("MP3: без VBR-заголовка — оценка по битрейту, с Xing — точно по числу кадров; ID3 пропускается", async () => {
  const cbr = blob(frame(), frame(), new Uint8Array(16_000_000 - 2 * 417));
  expect(await headerDuration(cbr)).toEqual({ seconds: 1000, exact: false });
  const id3 = blob([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 20], new Uint8Array(20), frame(), frame(), new Uint8Array(1000));
  expect((await headerDuration(id3))?.exact).toBe(false);
  // Xing после 32 байт side info: 1000 кадров × 1152 / 44100.
  const xing = blob(frame([...new Array(32).fill(0), ...ascii("Xing"), ...u32be(1), ...u32be(1000)]), frame(), new Uint8Array(100));
  expect((await headerDuration(xing))?.seconds).toBeCloseTo((1000 * 1152) / 44100, 6);
  expect((await headerDuration(xing))?.exact).toBe(true);
});

it("FLAC: STREAMINFO — число отсчётов / частота", async () => {
  const rate = 44100;
  const total = rate * 3 * 3600;
  const info = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (rate >> 12) & 255, (rate >> 4) & 255, ((rate & 15) << 4) | 0x02, 0x70 | Math.floor(total / 2 ** 32), ...u32be(total >>> 0)];
  expect(await headerDuration(blob([...ascii("fLaC"), 0x80, 0, 0, 34], info, new Uint8Array(16)))).toEqual({ seconds: 10800, exact: true });
});

it("M4A: длительность из mvhd, даже если moov лежит после данных", async () => {
  const box = (type: string, body: number[] | Uint8Array) => [...u32be(8 + body.length), ...ascii(type), ...body];
  const mvhd = box("mvhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(754_000), ...new Array(80).fill(0)]);
  const file = blob(box("ftyp", [...ascii("M4A "), 0, 0, 0, 0]), box("mdat", new Array(200_000).fill(0)), box("moov", mvhd));
  expect(await headerDuration(file)).toEqual({ seconds: 754, exact: true });
});

it("неизвестный или испорченный файл — null", async () => {
  expect(await headerDuration(blob(new TextEncoder().encode("Это текстовый файл, а не музыка.\n".repeat(50))))).toBeNull();
  expect(await headerDuration(blob(new Uint8Array(1000)))).toBeNull();
  expect(await headerDuration(blob([...ascii("OggS"), ...new Array(100).fill(0)]))).toBeNull();
  // Одиночный «синхрослово» без второго кадра не считается MP3.
  expect(await headerDuration(blob([0xff, 0xfb, 0x90, 0x00, ...new Array(1000).fill(0x20)]))).toBeNull();
});

it("неизвестная длительность в заголовке (0 или все единицы) — null, решают <audio> и проверка после раскодирования", async () => {
  const box = (type: string, body: number[] | Uint8Array) => [...u32be(8 + body.length), ...ascii(type), ...body];
  const m4a = (mvhdBody: number[]) => blob(box("ftyp", [...ascii("M4A "), 0, 0, 0, 0]), box("moov", box("mvhd", [...mvhdBody, ...new Array(80).fill(0)])));
  // Фрагментированный MP4 (frag_keyframe, DASH): в mvhd длительность 0.
  expect(await headerDuration(m4a([0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(0)]))).toBeNull();
  expect(await headerDuration(m4a([0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(0xffffffff)]))).toBeNull();
  const ones = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  expect(await headerDuration(m4a([1, 0, 0, 0, ...new Array(16).fill(0), ...u32be(1000), ...ones]))).toBeNull();
  // MP3 с Xing/VBRI без числа кадров: не «0 секунд».
  const xing = blob(frame([...new Array(32).fill(0), ...ascii("Xing"), ...u32be(1), ...u32be(0)]), frame(), new Uint8Array(100));
  expect(await headerDuration(xing)).toBeNull();
  const vbri = blob(frame([...new Array(32).fill(0), ...ascii("VBRI"), ...new Array(10).fill(0), ...u32be(0)]), frame(), new Uint8Array(100));
  expect(await headerDuration(vbri)).toBeNull();
});
