// Захват микрофона: AudioContext + AudioWorklet + Worker детектора. Запись остаётся в памяти;
// для точной оценки подписчик onPcm получает тот же звук от нулевой секунды песни.
import workletUrl from "./capture.worklet.js?url";
import type { PitchFrame } from "#lib/scoring/types.ts";
import type { Recording } from "#lib/session.svelte.ts";

export class Capture {
  frames: PitchFrame[] = [];
  chunks: { time: number; data: Float32Array }[] = [];
  start = Infinity;
  end = Infinity;
  /** Сырой звук окна попытки по порядку, без пропусков: первый отсчёт — нулевая секунда песни. */
  onPcm: ((pcm: Float32Array, sampleRate: number) => void) | null = null;
  private delivered = 0;

  private constructor(
    readonly ctx: AudioContext,
    readonly stream: MediaStream,
    private readonly node: AudioWorkletNode,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly worker: Worker,
  ) {}

  /** echoCancellation — режим «Без наушников»: браузер приглушает звук песни из динамика. */
  static async open(onFrame: (f: PitchFrame) => void, deviceId?: string, options: { echoCancellation?: boolean } = {}): Promise<Capture> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Микрофон доступен только по HTTPS или на localhost.");
    const ctx = new AudioContext({ latencyHint: "interactive" });
    let worker: Worker | null = null;
    try {
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: options.echoCancellation === true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      const node = new AudioWorkletNode(ctx, "perepev-capture");
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // Выход без звука: узел должен быть подключён, чтобы process() вызывался.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      worker = new Worker(new URL("./pitch.worker.ts", import.meta.url), { type: "module" });
      const channel = new MessageChannel();
      worker.postMessage({ port: channel.port1, sampleRate: ctx.sampleRate }, [channel.port1]);
      node.port.postMessage({ kind: "pitch-port", port: channel.port2 }, [channel.port2]);
      const capture = new Capture(ctx, stream, node, source, worker);
      worker.onmessage = ({ data }: MessageEvent<{ time: number; midi: number | null; clarity: number; rms: number }>) => {
        const f: PitchFrame = { t: data.time - capture.start, midi: data.midi, clarity: data.clarity, rms: data.rms };
        onFrame(f);
        if (f.t >= 0 && data.time <= capture.end) capture.frames.push(f);
      };
      node.port.onmessage = ({ data }) => {
        if (data.kind === "raw" && data.time + data.data.length / ctx.sampleRate >= capture.start && data.time <= capture.end) {
          capture.chunks.push(data);
          capture.deliver(data);
        }
      };
      return capture;
    } catch (e) {
      worker?.terminate();
      await ctx.close();
      throw e;
    }
  }

  begin(at: number, duration: number) {
    this.frames = [];
    this.chunks = [];
    this.start = at;
    this.end = at + duration;
    this.delivered = 0;
  }

  /** Часть блока внутри окна попытки; разрыв по времени заполняется тишиной, чтобы не сбить ритм. */
  private deliver(chunk: { time: number; data: Float32Array }) {
    const sink = this.onPcm;
    if (!sink) return;
    const rate = this.ctx.sampleRate;
    const total = Math.ceil((this.end - this.start) * rate);
    const first = Math.round((chunk.time - this.start) * rate);
    if (first > this.delivered) {
      const gap = Math.min(first, total) - this.delivered;
      if (gap > 0) sink(new Float32Array(gap), rate);
      this.delivered += Math.max(0, gap);
    }
    const from = Math.max(0, this.delivered - first);
    const to = Math.min(chunk.data.length, total - first);
    if (to > from) {
      sink(chunk.data.slice(from, to), rate);
      this.delivered = first + to;
    }
  }

  recording(): Recording {
    const samples = new Float32Array(Math.ceil((this.end - this.start) * this.ctx.sampleRate));
    for (const chunk of this.chunks) {
      const offset = Math.round((chunk.time - this.start) * this.ctx.sampleRate);
      const from = Math.max(0, -offset);
      const length = Math.min(chunk.data.length - from, samples.length - Math.max(0, offset));
      if (length > 0) samples.set(chunk.data.subarray(from, from + length), Math.max(0, offset));
    }
    return { samples, sampleRate: this.ctx.sampleRate };
  }

  stop() {
    this.onPcm = null;
    this.worker.onmessage = null;
    this.worker.terminate();
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}

export function micError(e: unknown): string {
  const err = e as Error;
  return err.name === "NotAllowedError"
    ? "Нет доступа к микрофону. Разреши доступ в настройках браузера и обнови страницу."
    : err.name === "NotFoundError" || err.name === "OverconstrainedError"
      ? "Выбранный микрофон не найден. Подключи его или выбери другой вход."
      : err.name === "NotReadableError"
        ? "Микрофон занят или недоступен. Закрой другие приложения со звуком и попробуй ещё раз."
        : err.message || "Не удалось включить микрофон.";
}

export async function loadBacking(ctx: BaseAudioContext, url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Минусовка не загрузилась. Проверь соединение и попробуй снова.");
  return ctx.decodeAudioData(await response.arrayBuffer());
}
