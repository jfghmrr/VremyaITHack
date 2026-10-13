import type { PitchFrame, Recording, Song } from "../types";
import type { ScoreResult } from "../scoring";
import { correctionCurve } from "./correction";
export type IdealEngine = "synth" | "voice";
export class Playback {
  private ctx: AudioContext;
  private nodes: AudioNode[] = [];
  private disposers: (() => void)[] = [];
  private timer = 0;
  private endTimer = 0;
  private closed = false;
  private dry: GainNode;
  private wet: GainNode;
  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry.connect(ctx.destination);
    this.wet.connect(ctx.destination);
    this.nodes.push(this.dry, this.wet);
  }
  static async create(
    recording: Recording,
    backing: AudioBuffer,
    song: Song,
    frames: PitchFrame[],
    result: ScoreResult,
    engine: IdealEngine,
    ideal: boolean,
    from = 0,
    to = song.duration_s,
    onEnd = () => {},
  ) {
    // Resume before any await/import so mobile gesture activation is retained.
    const ctx = new AudioContext();
    const resumed = ctx.resume();
    const p = new Playback(ctx);
    try {
      await resumed;
      const length = Math.max(0.02, to - from);
      const voice = ctx.createBuffer(
        1,
        recording.samples.length,
        recording.sampleRate,
      );
      voice.copyToChannel(new Float32Array(recording.samples), 0);
      const curve = correctionCurve(frames, song, result);
      let tonePlayer: import("tone").Player | undefined;
      let effect: import("tone").PitchShift | undefined;
      if (engine === "voice") {
        const Tone = await import("tone");
        const toneContext = new Tone.Context({ context: ctx, lookAhead: 0 });
        effect = new Tone.PitchShift({
          context: toneContext,
          pitch: 0,
          windowSize: 0.07,
          delayTime: 0,
          feedback: 0,
          wet: 1,
        });
        effect.connect(p.wet);
        tonePlayer = new Tone.Player({
          context: toneContext,
          url: voice,
          fadeIn: 0.01,
          fadeOut: 0.02,
        }).connect(effect);
        p.disposers.push(() => {
          tonePlayer?.dispose();
          effect?.dispose();
          toneContext.dispose();
        });
      }
      const at = ctx.currentTime + 0.08;
      const backingSource = ctx.createBufferSource();
      backingSource.buffer = backing;
      const bg = ctx.createGain();
      bg.gain.value = 0.65;
      backingSource.connect(bg);
      bg.connect(ctx.destination);
      backingSource.start(at, from, length);
      p.nodes.push(backingSource, bg);
      const offset = Math.max(0, from + result.lag),
        delay = Math.max(0, -from - result.lag),
        voiceLength = Math.min(length - delay, voice.duration - offset);
      if (voiceLength > 0) {
        const raw = ctx.createBufferSource();
        raw.buffer = voice;
        raw.connect(p.dry);
        raw.start(at + delay, offset, voiceLength);
        p.nodes.push(raw);
        tonePlayer?.start(at + delay, offset, voiceLength);
      }
      if (engine === "synth") {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        const env = ctx.createGain();
        env.gain.value = 0;
        osc.connect(env);
        for (const [frequency, q, gain] of [
          [700, 4, 0.3],
          [1200, 5, 0.17],
          [2500, 6, 0.07],
        ]) {
          const filter = ctx.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.value = frequency;
          filter.Q.value = q;
          const level = ctx.createGain();
          level.gain.value = gain;
          env.connect(filter);
          filter.connect(level);
          level.connect(p.wet);
          p.nodes.push(filter, level);
        }
        for (const point of curve) {
          if (point.t < from || point.t >= to) continue;
          const when = at + point.t - from;
          if (point.target !== null)
            osc.frequency.setTargetAtTime(
              440 * 2 ** ((point.target - 69) / 12),
              when,
              0.008,
            );
          env.gain.setTargetAtTime(
            point.target === null ? 0 : 0.45,
            when,
            0.008,
          );
        }
        osc.start(at);
        osc.stop(at + length);
        p.nodes.push(osc, env);
      } else if (effect) {
        const fx = effect;
        // PitchShift.pitch is a number setter (not AudioParam). Update on a 20 ms clock.
        const update = () => {
          const t = ctx.currentTime - at + from;
          const point =
            curve[
              Math.max(0, Math.min(curve.length - 1, Math.round(t / 0.02)))
            ];
          fx.pitch = point?.pitch ?? 0;
        };
        update();
        p.timer = window.setInterval(update, 20);
      }
      p.setIdeal(ideal);
      p.endTimer = window.setTimeout(
        () => {
          p.stop();
          onEnd();
        },
        (length + 0.12) * 1000,
      );
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
          /* ended */
        }
      }
      node.disconnect();
    }
    if (this.ctx.state !== "closed") void this.ctx.close();
  }
}
