// Переслушивание попытки: A — запись как есть, B — ориентир в твоей тональности.
// «synth» — синтезированный голос (не твой тембр, см. guide.ts); «voice» — твоя запись через
// Tone.PitchShift (эксперимент: артефакты, не исправляет ритм и пропуски).
import type { CorrectionPoint, ScoreResult } from "#lib/scoring/types.ts";
import type { Recording } from "#lib/session.svelte.ts";
import type { PlayMode } from "#lib/precise/uploader.ts";
import { normalizeRecording } from "./level.ts";

/** Голос исполнителя в наушниках звучит тихо (около −15 дБ), только как подсказка. */
export const GUIDE_GAIN = 0.18;

/** Что звучит во время пения: при отдельных дорожках — минус и (в наушниках) голос-подсказка, иначе исходный микс. */
export function songLayers(backing: string, stems: boolean, mode: PlayMode): { file: string; gain: number }[] {
  if (!stems) return [{ file: backing, gain: 1 }];
  const instrumental = { file: "instrumental.mp3", gain: 1 };
  return mode === "headphones" ? [instrumental, { file: "guide.mp3", gain: GUIDE_GAIN }] : [instrumental];
}

/**
 * Загружает дорожки для пения. Если минус или голос-подсказка не загрузились, звучит исходный
 * микс `backing` (как у песни без отдельных дорожек): проверка микрофона не падает из-за них.
 * `stems` в ответе — звучат ли отдельные дорожки на самом деле.
 */
export async function loadLayers(
  backing: string,
  stems: boolean,
  mode: PlayMode,
  load: (file: string) => Promise<AudioBuffer>,
): Promise<{ layers: { buffer: AudioBuffer; gain: number }[]; stems: boolean }> {
  try {
    const layers = await Promise.all(songLayers(backing, stems, mode).map(async (l) => ({ buffer: await load(l.file), gain: l.gain })));
    return { layers, stems };
  } catch (e) {
    if (!stems) throw e;
    return { layers: [{ buffer: await load(backing), gain: 1 }], stems: false };
  }
}

/** Запускает дорожки одновременно по часам контекста; stop() глушит все сразу. */
export function startLayers(ctx: AudioContext, layers: { buffer: AudioBuffer; gain: number }[], at: number) {
  const nodes = layers.map(({ buffer, gain }) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = gain;
    source.connect(level).connect(ctx.destination);
    source.start(at);
    return { source, level };
  });
  return {
    stop() {
      for (const { source, level } of nodes) {
        try {
          source.stop();
        } catch {
          /* уже остановлен */
        }
        source.disconnect();
        level.disconnect();
      }
    },
  };
}

export type IdealEngine = "synth" | "voice";

export interface PlaybackOptions {
  recording: Recording;
  backing: AudioBuffer;
  duration: number;
  result: ScoreResult;
  curve: CorrectionPoint[];
  /** Готовый звук синтезированного ориентира от начала песни (guide.ts `renderGuide`). */
  guide?: { samples: Float32Array<ArrayBuffer>; rate: number };
  engine: IdealEngine;
  ideal: boolean;
  from?: number;
  to?: number;
  onEnd?: () => void;
}

export class Playback {
  private nodes: AudioNode[] = [];
  private disposers: (() => void)[] = [];
  private timer = 0;
  private endTimer = 0;
  private closed = false;
  private startTime = 0;
  private from = 0;
  private to = 0;

  get position(): number { return Math.min(this.to, Math.max(this.from, this.ctx.currentTime - this.startTime + this.from)); }
  private readonly dry: GainNode;
  private readonly wet: GainNode;

  private constructor(private readonly ctx: AudioContext) {
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry.connect(ctx.destination);
    this.wet.connect(ctx.destination);
    this.nodes.push(this.dry, this.wet);
  }

  static async create(o: PlaybackOptions): Promise<Playback> {
    // resume() до первого await, чтобы сохранить активацию от жеста пользователя.
    const ctx = new AudioContext();
    const resumed = ctx.resume();
    const p = new Playback(ctx);
    const from = o.from ?? 0;
    const to = o.to ?? o.duration;
    try {
      await resumed;
      const length = Math.max(0.02, to - from);
      const voice = ctx.createBuffer(1, o.recording.samples.length, o.recording.sampleRate);
      // Ровная громкость своего голоса: тихая запись поднимается (до ×8), пики мягко ограничены.
      voice.copyToChannel(normalizeRecording(o.recording.samples, o.recording.sampleRate), 0);
      let tonePlayer: import("tone").Player | undefined;
      let effect: import("tone").PitchShift | undefined;
      if (o.engine === "voice") {
        const Tone = await import("tone");
        const toneContext = new Tone.Context({ context: ctx, lookAhead: 0 });
        effect = new Tone.PitchShift({ context: toneContext, pitch: 0, windowSize: 0.07, delayTime: 0, feedback: 0, wet: 1 });
        effect.connect(p.wet);
        tonePlayer = new Tone.Player({ context: toneContext, url: voice, fadeIn: 0.01, fadeOut: 0.02 }).connect(effect);
        p.disposers.push(() => {
          tonePlayer?.dispose();
          effect?.dispose();
          toneContext.dispose();
        });
      }
      const at = ctx.currentTime + 0.08;
      p.startTime = at; p.from = from; p.to = to;
      const backingSource = ctx.createBufferSource();
      backingSource.buffer = o.backing;
      const bg = ctx.createGain();
      bg.gain.value = 0.65;
      backingSource.connect(bg).connect(ctx.destination);
      backingSource.start(at, from, length);
      p.nodes.push(backingSource, bg);
      // Измеренная задержка записи компенсируется и при переслушивании.
      const offset = Math.max(0, from + o.result.lag);
      const delay = Math.max(0, -from - o.result.lag);
      const voiceLength = Math.min(length - delay, voice.duration - offset);
      if (voiceLength > 0) {
        const raw = ctx.createBufferSource();
        raw.buffer = voice;
        raw.connect(p.dry);
        raw.start(at + delay, offset, voiceLength);
        p.nodes.push(raw);
        tonePlayer?.start(at + delay, offset, voiceLength);
      }
      if (o.engine === "synth" && o.guide && o.guide.samples.length) {
        // Ориентир посчитан заранее: один буфер по тем же часам контекста, что и минус.
        const buffer = ctx.createBuffer(1, o.guide.samples.length, o.guide.rate);
        buffer.copyToChannel(o.guide.samples, 0);
        const guide = ctx.createBufferSource();
        guide.buffer = buffer;
        guide.connect(p.wet);
        const guideLength = Math.min(length, buffer.duration - from);
        if (guideLength > 0) guide.start(at, from, guideLength);
        p.nodes.push(guide);
      } else if (effect) {
        const fx = effect;
        // PitchShift.pitch — числовое свойство, не AudioParam: обновление по таймеру 20 мс.
        const update = () => {
          const t = ctx.currentTime - at + from;
          const point = o.curve[Math.max(0, Math.min(o.curve.length - 1, Math.round(t / 0.02)))];
          fx.pitch = point?.pitch ?? 0;
        };
        update();
        p.timer = window.setInterval(update, 20);
      }
      p.setIdeal(o.ideal);
      p.endTimer = window.setTimeout(() => {
        p.stop();
        o.onEnd?.();
      }, (length + 0.12) * 1000);
      return p;
    } catch (e) {
      p.stop();
      throw e;
    }
  }

  setIdeal(ideal: boolean) {
    if (this.closed) return;
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(ideal ? 0 : 1, t, 0.018);
    this.wet.gain.setTargetAtTime(ideal ? 1 : 0, t, 0.018);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.timer);
    window.clearTimeout(this.endTimer);
    for (const dispose of this.disposers) dispose();
    for (const node of this.nodes) {
      if (node instanceof AudioScheduledSourceNode) {
        try {
          node.stop();
        } catch {
          /* уже остановлен */
        }
      }
      node.disconnect();
    }
    if (this.ctx.state !== "closed") void this.ctx.close();
  }
}
