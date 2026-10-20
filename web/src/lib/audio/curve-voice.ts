// Прослушивание дуэли: звук участников не записывается и не передаётся, у каждого есть только
// линия высоты с шагом 50 мс. Её озвучивает тот же синтезированный голос, что и «Ориентир» на
// экране результата (пилообразная волна через три форманты): слышны мелодия и ритм так, как
// спел участник, без тембра и слов. Под линии можно подложить минус песни.
import type { PitchFrame } from "#lib/scoring/types.ts";

export interface VoiceLine {
  frames: PitchFrame[];
  /** Сдвиг в полутонах (например, чтобы обе линии звучали в одной тональности). */
  shift?: number;
  /** Панорама −1…1: при прослушивании обоих голоса разведены по сторонам. */
  pan?: number;
  gain?: number;
}

export interface CurveVoiceOptions {
  lines: VoiceLine[];
  backing?: AudioBuffer | null;
  from?: number;
  to: number;
  onEnd?: () => void;
  /**
   * Общий контекст прослушивания (создан по нажатию): stop() его не закрывает, закрывает
   * владелец. Так «Вместе» переключает уже звучащий синтезированный голос на настоящие голоса
   * без нового нажатия: новый контекст без жеста может остаться приостановленным правилами автозапуска.
   */
  ctx?: AudioContext;
}

const FORMANTS: [number, number, number][] = [
  [700, 4, 0.3],
  [1200, 5, 0.17],
  [2500, 6, 0.07],
];

/** Кадры линии для звучания в окне [from, to): частота и громкость по времени от начала окна. */
export function voiceSchedule(frames: PitchFrame[], from: number, to: number, shift = 0): { at: number; hz: number | null }[] {
  const out: { at: number; hz: number | null }[] = [];
  for (const f of frames) {
    if (!Number.isFinite(f.t) || f.t < from || f.t >= to) continue;
    out.push({ at: f.t - from, hz: f.midi === null ? null : 440 * 2 ** ((f.midi + shift - 69) / 12) });
  }
  return out;
}

/**
 * Останавливает узлы прослушивания сейчас или в момент `when` часов контекста (тогда узлы
 * отключаются после него — звук до `when` не обрывается). Чужой контекст (`ownsCtx = false`)
 * не закрывается: его закрывает владелец.
 */
export function silence(nodes: AudioNode[], ctx: AudioContext, ownsCtx: boolean, when?: number) {
  const live = ctx.state !== "closed";
  const at = when !== undefined && live ? Math.max(when, ctx.currentTime) : undefined;
  for (const node of nodes) {
    if (node instanceof AudioScheduledSourceNode) {
      try {
        if (at === undefined) node.stop();
        else node.stop(at);
      } catch {
        /* уже остановлен или не запускался */
      }
    }
  }
  const release = () => {
    for (const node of nodes) node.disconnect();
    if (ownsCtx && ctx.state !== "closed") void ctx.close();
  };
  if (at === undefined) release();
  else window.setTimeout(release, (at - ctx.currentTime) * 1000 + 50);
}

export class CurveVoices {
  private nodes: AudioNode[] = [];
  private endTimer = 0;
  private closed = false;
  private startTime = 0;
  private ownsCtx = true;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly from: number,
    private readonly to: number,
  ) {}

  get position(): number {
    return this.positionAt(this.ctx.currentTime);
  }

  /** Когда звук начинается, по часам контекста. */
  get startsAt(): number {
    return this.startTime;
  }

  /** Место в песне в момент `t` часов контекста. */
  positionAt(t: number): number {
    return Math.min(this.to, Math.max(this.from, t - this.startTime + this.from));
  }

  static async play(o: CurveVoiceOptions): Promise<CurveVoices> {
    // resume() до первого await: сохраняется активация от нажатия кнопки.
    const ctx = o.ctx ?? new AudioContext();
    const resumed = ctx.resume();
    const from = o.from ?? 0;
    const p = new CurveVoices(ctx, from, o.to);
    p.ownsCtx = !o.ctx;
    try {
      await resumed;
      const length = Math.max(0.05, o.to - from);
      const at = ctx.currentTime + 0.08;
      p.startTime = at;
      if (o.backing) {
        const src = ctx.createBufferSource();
        src.buffer = o.backing;
        const g = ctx.createGain();
        g.gain.value = 0.45;
        src.connect(g).connect(ctx.destination);
        src.start(at, from, length);
        p.nodes.push(src, g);
      }
      for (const line of o.lines) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        const env = ctx.createGain();
        env.gain.value = 0;
        const out = ctx.createGain();
        out.gain.value = line.gain ?? 1;
        const pan = ctx.createStereoPanner();
        pan.pan.value = line.pan ?? 0;
        out.connect(pan).connect(ctx.destination);
        osc.connect(env);
        for (const [frequency, q, gain] of FORMANTS) {
          const filter = ctx.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.value = frequency;
          filter.Q.value = q;
          const level = ctx.createGain();
          level.gain.value = gain;
          env.connect(filter);
          filter.connect(level).connect(out);
          p.nodes.push(filter, level);
        }
        for (const point of voiceSchedule(line.frames, from, o.to, line.shift ?? 0)) {
          const when = at + point.at;
          if (point.hz !== null) osc.frequency.setTargetAtTime(point.hz, when, 0.008);
          env.gain.setTargetAtTime(point.hz === null ? 0 : 0.45, when, 0.008);
        }
        osc.start(at);
        osc.stop(at + length);
        p.nodes.push(osc, env, out, pan);
      }
      p.endTimer = window.setTimeout(() => {
        p.stop();
        o.onEnd?.();
      }, (length + 0.15) * 1000);
      return p;
    } catch (e) {
      p.stop();
      throw e;
    }
  }

  /** Остановить сейчас или в момент `when` часов контекста (передача настоящим голосам без паузы). */
  stop(when?: number) {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.endTimer);
    silence(this.nodes, this.ctx, this.ownsCtx, when);
  }
}
