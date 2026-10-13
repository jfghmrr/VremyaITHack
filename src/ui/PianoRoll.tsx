import { useMemo } from "react";
import type { PitchFrame, Song } from "../types";
import { median } from "../scoring/math";
import { palette, useCanvas, useReducedMotion } from "./canvas";
export function PianoRoll({
  song,
  frames,
  time,
  ghost,
  ghostShift = 0,
}: {
  song: Song;
  frames: PitchFrame[];
  time: number;
  ghost?: PitchFrame[];
  ghostShift?: number;
}) {
  const reduce = useReducedMotion();
  const reference = useMemo(
    () =>
      song.f0_midi.map((m, i) => ({ t: (i * song.hop_ms) / 1000, midi: m })),
    [song],
  );
  const range = useMemo(() => {
    const notes = song.f0_midi.filter((n): n is number => n !== null);
    return { lo: Math.min(...notes) - 3, hi: Math.max(...notes) + 3 };
  }, [song]);
  const ref = useCanvas((ctx, w, h) => {
    const c = palette(ctx.canvas),
      { lo, hi } = range;
    const left = time - 2,
      span = 9,
      x = (t: number) => ((t - left) / span) * w,
      y = (m: number) => h - 28 - ((m - lo) / (hi - lo)) * (h - 56);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.grid;
    ctx.font = "12px Onest, sans-serif";
    for (let m = lo; m <= hi; m++) {
      ctx.beginPath();
      ctx.moveTo(0, y(m));
      ctx.lineTo(w, y(m));
      ctx.stroke();
    }
    for (let t = Math.max(0, Math.floor(left)); t < left + span; t++) {
      ctx.beginPath();
      ctx.moveTo(x(t), 0);
      ctx.lineTo(x(t), h);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.fillText(`${t} с`, x(t) + 6, h - 10);
    }
    const visible = (points: PitchFrame[]) =>
      points.filter((f) => f.t >= left - 0.1 && f.t <= left + span + 0.1);
    const referenceVisible = visible(reference),
      user = visible(frames),
      rival = ghost ? visible(ghost) : [];
    const diffs = frames.slice(-350).flatMap((f) => {
      const r = song.f0_midi[Math.round((f.t * 1000) / song.hop_ms)];
      return f.midi !== null && r != null ? [f.midi - r] : [];
    });
    const shift = median(diffs);
    const line = (
      points: PitchFrame[],
      offset: number,
      color: string,
      width: number,
      dy = 0,
      alpha = 1,
      byError = false,
      dash = false,
    ) => {
      ctx.globalAlpha = alpha;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      let prev: PitchFrame | null = null;
      for (const f of points) {
        if (f.midi === null) {
          prev = null;
          continue;
        }
        if (prev?.midi != null && f.t - prev.t < 0.08) {
          const r = song.f0_midi[Math.round((f.t * 1000) / song.hop_ms)];
          const error = r == null ? 0 : Math.abs(f.midi - offset - r);
          ctx.strokeStyle = byError
            ? error < 0.6
              ? c.echo
              : error < 1.5
                ? c.amber
                : c.pink
            : color;
          ctx.lineWidth = byError ? (error >= 1.5 ? 4 : 2.5) : width;
          ctx.setLineDash(
            dash ? [5, 5] : byError && error >= 1.5 ? [3, 4] : [],
          );
          ctx.lineDashOffset = -x(prev.t);
          ctx.beginPath();
          ctx.moveTo(x(prev.t), y(prev.midi - offset) + dy);
          ctx.lineTo(x(f.t), y(f.midi - offset) + dy);
          ctx.stroke();
        }
        prev = f;
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    };
    line(referenceVisible, 0, c.muted, 5, 0, 0.55);
    if (rival.length) {
      if (!reduce) {
        line(rival, ghostShift, c.ghost, 2, 12, 0.16);
        line(rival, ghostShift, c.ghost, 2, 24, 0.08);
        line(rival, ghostShift, c.ghost, 2, 36, 0.04);
      }
      line(rival, ghostShift, c.ghost, 2, 0, 0.7, false, true);
    }
    if (!reduce) {
      line(user, shift, c.echo, 2, 8, 0.2);
      line(user, shift, c.echo, 2, 16, 0.1);
    }
    line(user, shift, c.echo, 2.5, 0, 1, true);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(time), 16);
    ctx.lineTo(x(time), h - 28);
    ctx.stroke();
    const latest = frames.at(-1);
    if (latest?.midi != null) {
      ctx.fillStyle = c.echo;
      ctx.beginPath();
      ctx.arc(x(latest.t), y(latest.midi - shift), 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  });
  return (
    <canvas
      ref={ref}
      className="piano"
      role="img"
      aria-label="Мелодия: эталон серым, твой голос фиолетовым, неточность янтарным, ошибка розовым штрихом, призрак синим пунктиром"
    />
  );
}
