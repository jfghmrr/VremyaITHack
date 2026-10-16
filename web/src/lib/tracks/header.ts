// Длительность звукового файла по заголовку, без раскодирования: WAV, MP3, FLAC и M4A/MP4.
// Нужна, чтобы отклонить слишком длинный файл до decodeAudioData, который держит в памяти весь
// звук. exact = false — оценка MP3 по битрейту первого кадра (без VBR-заголовка Xing/VBRI).
export interface HeaderDuration {
  seconds: number;
  exact: boolean;
}

const HEAD = 64 * 1024;

const read = async (file: Blob, from: number, to: number) => new Uint8Array(await file.slice(from, to).arrayBuffer());
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export async function headerDuration(file: Blob): Promise<HeaderDuration | null> {
  const head = await read(file, 0, HEAD);
  if (head.length < 12) return null;
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return wav(head, file.size);
  if (ascii(head, 4, 4) === "ftyp") return mp4(file);
  // ID3v2 перед MP3 или FLAC: размер в «syncsafe»-байтах, плюс подвал при флаге 0x10.
  const tag = ascii(head, 0, 3) === "ID3" ? 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]) + (head[5] & 0x10 ? 10 : 0) : 0;
  // Обложка в ID3 бывает больше начального блока: тогда читаем сразу после тега.
  const body = tag > HEAD - 1024 ? await read(file, tag, tag + HEAD) : head.subarray(tag);
  if (ascii(body, 0, 4) === "fLaC") return flac(body, 0);
  return mp3(body, 0, file.size - tag);
}

function wav(b: Uint8Array, size: number): HeaderDuration | null {
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4);
    const length = u32le(b, at + 4);
    if (id === "fmt ") byteRate = u32le(b, at + 16);
    if (id === "data") {
      if (!byteRate) return null;
      // Заголовок может обещать больше, чем есть в файле, или не знать размер (0 / 0xFFFFFFFF).
      const available = size - (at + 8);
      const bytes = length === 0 || length === 0xffffffff ? available : Math.min(length, available);
      return { seconds: bytes / byteRate, exact: true };
    }
    at += 8 + length + (length & 1);
  }
  return null;
}

const KBPS_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Первый кадр MPEG Layer III, за которым сразу идёт второй (защита от случайного 0xFF). */
function mp3(b: Uint8Array, from: number, size: number): HeaderDuration | null {
  for (let at = from; at + 4 <= b.length; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1] >> 3) & 3;
    const layer = (b[at + 1] >> 1) & 3;
    const index = b[at + 2] >> 4;
    const rateIndex = (b[at + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || rateIndex === 3) continue;
    const mpeg1 = version === 3;
    const kbps = (mpeg1 ? KBPS_MPEG1 : KBPS_MPEG2)[index];
    const rate = SAMPLE_RATES[version][rateIndex];
    const next = at + Math.floor(((mpeg1 ? 144_000 : 72_000) * kbps) / rate) + ((b[at + 2] >> 1) & 1);
    if (next + 1 >= b.length || b[next] !== 0xff || (b[next + 1] & 0xe0) !== 0xe0) continue;
    const perFrame = mpeg1 ? 1152 : 576;
    const mono = b[at + 3] >> 6 === 3;
    const xing = at + 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    const marker = ascii(b, xing, 4);
    // VBR-заголовок без числа кадров (0 или все единицы) не знает длительность: решат <audio> и раскодирование.
    if ((marker === "Xing" || marker === "Info") && b[xing + 7] & 1) return frames(u32be(b, xing + 8), perFrame, rate);
    if (ascii(b, at + 36, 4) === "VBRI") return frames(u32be(b, at + 50), perFrame, rate);
    return { seconds: ((size - at) * 8) / (kbps * 1000), exact: false };
  }
  return null;
}

function frames(count: number, perFrame: number, rate: number): HeaderDuration | null {
  return count === 0 || count === 0xffffffff ? null : { seconds: (count * perFrame) / rate, exact: true };
}

function flac(b: Uint8Array, at: number): HeaderDuration | null {
  if ((b[at + 4] & 0x7f) !== 0) return null;
  const s = at + 8;
  const rate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
  const total = (b[s + 13] & 0x0f) * 2 ** 32 + u32be(b, s + 14);
  return rate && total ? { seconds: total / rate, exact: true } : null;
}

/** Обход верхних блоков MP4 по заголовкам (moov бывает после mdat), длительность из mvhd. */
async function mp4(file: Blob): Promise<HeaderDuration | null> {
  for (let at = 0, n = 0; n < 64 && at + 8 <= file.size; n++) {
    const h = await read(file, at, at + 16);
    let size = u32be(h, 0);
    let header = 8;
    if (size === 1) [size, header] = [u32be(h, 8) * 2 ** 32 + u32be(h, 12), 16];
    else if (size === 0) size = file.size - at;
    if (size < header) return null;
    if (ascii(h, 4, 4) === "moov") return mvhd(await read(file, at + header, Math.min(at + size, at + header + HEAD)));
    at += size;
  }
  return null;
}

function mvhd(b: Uint8Array): HeaderDuration | null {
  for (let at = 0; at + 8 <= b.length; ) {
    const size = u32be(b, at);
    if (ascii(b, at + 4, 4) === "mvhd") {
      const s = at + 12;
      const v1 = b[at + 8] === 1;
      const scale = u32be(b, v1 ? s + 16 : s + 8);
      const [high, low] = v1 ? [u32be(b, s + 20), u32be(b, s + 24)] : [0, u32be(b, s + 12)];
      // Фрагментированный MP4 (frag_keyframe, DASH) хранит 0 или все единицы: длительность неизвестна.
      const unknown = (high === 0 && low === 0) || (low === 0xffffffff && (!v1 || high === 0xffffffff));
      return scale && !unknown ? { seconds: (high * 2 ** 32 + low) / scale, exact: true } : null;
    }
    if (size < 8) return null;
    at += size;
  }
  return null;
}
