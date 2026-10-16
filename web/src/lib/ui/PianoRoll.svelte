<script lang="ts">
  // Широкий piano roll сцены. Рисует эталон (графит), свой голос (малиновый) и соперника
  // (индиго, пунктир). Неточность — тоньше и прозрачнее, ошибка — штрих: не только цветом.
  import type { PitchFrame, Song } from "#lib/scoring/types.ts";
  import { css, median, paint } from "./canvas";

  let {
    song,
    frames,
    time,
    rival = null,
    rivalShift = 0,
    span = 9,
    label = "Мелодия: эталон серым, твой голос малиновым",
  }: {
    song: Song;
    /** Кадры читаются на каждом кадре анимации, без реактивных обновлений. */
    frames: () => PitchFrame[];
    time: () => number;
    rival?: PitchFrame[] | null;
    rivalShift?: number;
    span?: number;
    label?: string;
  } = $props();

  const notes = $derived(song.f0_midi.filter((n): n is number => n !== null));
  const lo = $derived(Math.min(...notes) - 4);
  const hi = $derived(Math.max(...notes) + 4);
  const hop = $derived(song.hop_ms / 1000);

  let shift = 0;
  let shiftedAt = -Infinity;

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const el = ctx.canvas;
    const own = frames();
    const c = {
      ref: css(el, "stage-reference"),
      self: css(el, "stage-accent"),
      rival: css(el, "stage-rival"),
      grid: css(el, "stage-line"),
      ink: css(el, "stage-ink-2"),
    };
    const now = Math.max(0, time());
    const left = now - span * 0.25;
    const x = (t: number) => ((t - left) / span) * w;
    const y = (m: number) => h - 32 - ((m - lo) / (hi - lo)) * (h - 64);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.grid;
    ctx.globalAlpha = 0.5;
    for (let m = Math.ceil(lo); m <= hi; m += 2) {
      ctx.beginPath();
      ctx.moveTo(0, y(m));
      ctx.lineTo(w, y(m));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ink;
    ctx.font = "500 12px 'Golos Text', sans-serif";
    for (let t = Math.max(0, Math.ceil(left)); t < left + span; t++) ctx.fillText(`${t} с`, x(t) + 6, h - 10);

    // Эталон: ноты как полосы piano roll.
    ctx.lineCap = "round";
    ctx.strokeStyle = c.ref;
    ctx.lineWidth = 10;
    const i0 = Math.max(0, Math.floor(left / hop));
    const i1 = Math.min(song.f0_midi.length - 1, Math.ceil((left + span) / hop));
    let run: [number, number] | null = null;
    const flush = (end: number) => {
      if (!run) return;
      ctx.beginPath();
      ctx.moveTo(x(run[0] * hop) + 5, y(run[1]));
      ctx.lineTo(Math.max(x(run[0] * hop) + 5, x(end * hop) - 5), y(run[1]));
      ctx.stroke();
      run = null;
    };
    for (let i = i0; i <= i1; i++) {
      const m = song.f0_midi[i];
      if (m === null || (run && Math.abs(m - run[1]) > 0.3)) flush(i);
      if (m !== null && !run) run = [i, m];
    }
    flush(i1);

    // Сдвиг тональности для отображения: медиана последних отклонений (только для картинки).
    // Тональный сдвиг меняется медленно: медиану не нужно сортировать 60 раз/с.
    if (now < shiftedAt || now - shiftedAt >= 0.1) {
      const recent = own.slice(-300).flatMap((f) => {
        const r = song.f0_midi[Math.round(f.t / hop)];
        return f.midi !== null && r != null ? [f.midi - r] : [];
      });
      shift = median(recent);
      shiftedAt = now;
    }

    const line = (points: PitchFrame[], offset: number, color: string, mode: "self" | "rival") => {
      ctx.strokeStyle = color;
      let prev: PitchFrame | null = null;
      // Бинарный поиск начала окна: длина уже спетой песни не замедляет график.
      let start = 0, end = points.length;
      while (start < end) {
        const mid = (start + end) >>> 1;
        if (points[mid].t < left - 0.2) start = mid + 1;
        else end = mid;
      }
      for (let i = start; i < points.length; i++) {
        const f = points[i];
        if (f.t > left + span) break;
        if (f.t < left - 0.2 || f.t > left + span) {
          prev = null;
          continue;
        }
        if (f.midi === null) {
          prev = null;
          continue;
        }
        if (prev?.midi != null && f.t - prev.t < 0.12) {
          const r = song.f0_midi[Math.round(f.t / hop)];
          const error = r == null ? 0 : Math.abs(f.midi - offset - r);
          if (mode === "rival") {
            ctx.setLineDash([6, 6]);
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.9;
          } else if (error >= 1.5) {
            ctx.setLineDash([3, 5]);
            ctx.lineWidth = 4;
            ctx.globalAlpha = 1;
          } else {
            ctx.setLineDash([]);
            ctx.lineWidth = error >= 0.6 ? 2.5 : 4;
            ctx.globalAlpha = error >= 0.6 ? 0.6 : 1;
          }
          ctx.lineDashOffset = -x(prev.t);
          ctx.beginPath();
          ctx.moveTo(x(prev.t), y(prev.midi - offset));
          ctx.lineTo(x(f.t), y(f.midi - offset));
          ctx.stroke();
        }
        prev = f;
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    if (rival) line(rival, rivalShift, c.rival, "rival");
    line(own, shift, c.self, "self");

    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(now), 12);
    ctx.lineTo(x(now), h - 32);
    ctx.stroke();
    const latest = own.at(-1);
    if (latest?.midi != null && now - latest.t < 0.3) {
      ctx.fillStyle = c.self;
      ctx.beginPath();
      ctx.arc(x(latest.t), y(latest.midi - shift), 6, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
</script>

<div class="canvas" role="img" aria-label={label}><canvas use:paint={{ draw, live: true }} aria-hidden="true"></canvas></div>

<style>
  .canvas,
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
