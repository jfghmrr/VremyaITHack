import { useEffect, useMemo, useRef, useState } from "react";
import type { PitchFrame, Song } from "../types";
import type { ScoreResult } from "../scoring";
import { resample } from "../scoring/alignment";
import { palette, useCanvas, useReducedMotion } from "./canvas";
export function ResultTrace({
  song,
  frames,
  result,
  ideal = false,
  rival,
  rivalResult,
}: {
  song: Song;
  frames: PitchFrame[];
  result: ScoreResult;
  ideal?: boolean;
  rival?: PitchFrame[];
  rivalResult?: ScoreResult;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(0),
    [mix, setMix] = useState(0);
  useEffect(() => {
    const from = progress.current,
      to = ideal ? 1 : 0,
      start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / 550);
      const value = from + (to - from) * (1 - (1 - t) ** 3);
      progress.current = value;
      setMix(value);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ideal, reduced]);
  const data = useMemo(() => {
    const user = resample(
      frames,
      song.f0_midi.length,
      song.hop_ms / 1000,
      result.lag,
    );
    const other =
      rival && rivalResult
        ? resample(
            rival,
            song.f0_midi.length,
            song.hop_ms / 1000,
            rivalResult.lag,
          )
        : null;
    return song.f0_midi
      .map((r, i) => ({
        t: (i * song.hop_ms) / 1000,
        target: r === null ? null : r + result.shiftCurve[i],
        user: user[i],
        rival:
          other?.[i] != null && rivalResult
            ? other[i]! - rivalResult.shiftCurve[i] + result.shiftCurve[i]
            : null,
      }))
      .filter((_, i) => i % 2 === 0);
  }, [frames, song, result, rival, rivalResult]);
  const ref = useCanvas((ctx, w, h) => {
    const c = palette(ctx.canvas);
    const pitches = data.flatMap((p) =>
      [p.target, p.user, p.rival].filter((m): m is number => m !== null),
    );
    const lo = pitches.length ? Math.min(...pitches) - 1 : 48,
      hi = pitches.length ? Math.max(...pitches) + 1 : 72;
    const x = (t: number) => 8 + (t / song.duration_s) * (w - 16),
      y = (m: number) => h - 18 - ((m - lo) / Math.max(4, hi - lo)) * (h - 32);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (h * i) / 4);
      ctx.lineTo(w, (h * i) / 4);
      ctx.stroke();
    }
    const line = (kind: "target" | "user" | "rival", dy = 0, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.lineCap = "round";
      let prev: { x: number; y: number } | null = null;
      for (const p of data) {
        const n = p[kind];
        if (n === null) {
          prev = null;
          continue;
        }
        const note =
          kind === "user" && p.target !== null ? n + (p.target - n) * mix : n;
        const point = { x: x(p.t), y: y(note) + dy };
        const error =
          kind === "user" && p.target !== null ? Math.abs(note - p.target) : 0;
        ctx.strokeStyle =
          kind === "target"
            ? c.muted
            : kind === "rival"
              ? c.ghost
              : error < 0.6
                ? c.echo
                : error < 1.5
                  ? c.amber
                  : c.pink;
        ctx.lineWidth = kind === "target" ? 1 : error >= 1.5 ? 3 : 2;
        ctx.setLineDash(kind === "rival" ? [4, 4] : error >= 1.5 ? [3, 3] : []);
        if (prev) {
          ctx.lineDashOffset = -prev.x;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
        }
        prev = point;
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    };
    line("target", 0, 0.65);
    if (rival) {
      if (!reduced) line("rival", 10, 0.12);
      line("rival", 0, 0.85);
    }
    if (!reduced) {
      line("user", 5, 0.16);
      line("user", 10, 0.07);
    }
    line("user");
  });
  return (
    <canvas
      ref={ref}
      className="result-trace"
      data-ideal={ideal}
      role="img"
      aria-label={
        rival
          ? "Общая линия двух попыток в одной тональности"
          : ideal
            ? "Идеальная линия высоты в твоей тональности. Пропуски голоса сохранены."
            : "Линия записанного голоса: синий — точно, янтарь — неточность, розовый штрих — ошибка"
      }
    />
  );
}
export function CountScore({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const [score, setScore] = useState(reduced ? value : 0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / 850);
      setScore(value * (1 - (1 - t) ** 3));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return (
    <span aria-label={`${Math.round(value)} баллов`}>{Math.round(score)}</span>
  );
}
