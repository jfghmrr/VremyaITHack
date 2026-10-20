// Режим «Вместе» на клиенте. Расписание ходов присылает сервер (MatchView.turns): клиент его
// не пересчитывает, а только читает — чей ход сейчас, чья строка, какие точки отправлять.
// partSong повторяет `coop::part_song` сервера (crates/api/src/coop.rs) для предварительного
// балла и разбора в браузере; итог партий и общий балл считает только сервер.
import type { Turn } from "#lib/api/types.ts";
import type { VoiceLine } from "#lib/audio/curve-voice.ts";
import type { Phrase, PitchFrame, Song } from "#lib/scoring/types.ts";

/** Шаг канонической кривой живого матча, с. */
const HOP = 0.05;
/** За сколько секунд до хода появляется подсказка «Сейчас поёшь ты / поёт …». */
export const CUE_LEAD_S = 1.5;
/** Сколько подсказка держится после начала хода. */
export const CUE_TAIL_S = 0.6;

/** Номер хода, в окно которого попадает момент `t`, или −1 (вступление, проигрыш, конец). */
export function turnAt(turns: Turn[], t: number): number {
  return turns.findIndex((w) => t >= w.start_s && t < w.end_s);
}

/** Момент `t` (с) попадает в ходы участника `slot`; та же проверка, что на сервере. */
export function inTurns(turns: Turn[], slot: number, t: number): boolean {
  return turns.some((w) => w.slot === slot && t >= w.start_s && t < w.end_s);
}

/** Чья строка текста: слот участника или null, если строка ни в одном ходе. */
export function ownerOfLine(turns: Turn[], line: number): number | null {
  return turns.find((w) => w.lines.includes(line))?.slot ?? null;
}

/** Точки кривой с индекса `from`: свои ходы как есть, остальное — пауза (null). */
export function maskPoints(points: (number | null)[], from: number, turns: Turn[], slot: number): (number | null)[] {
  return points.map((p, k) => (inTurns(turns, slot, (from + k) * HOP) ? p : null));
}

/**
 * Подсказка перед ходом: за CUE_LEAD_S до начала и CUE_TAIL_S после него —
 * какой ход и поёт ли его этот участник. Иначе null.
 */
export function cueAt(turns: Turn[], slot: number, t: number): { turn: number; mine: boolean } | null {
  const k = turns.findIndex((w) => t >= w.start_s - CUE_LEAD_S && t < w.start_s + CUE_TAIL_S);
  return k < 0 ? null : { turn: k, mine: turns[k].slot === slot };
}

/** Эталон партии: высота вне своих ходов — пауза, фразы обрезаны своими ходами. */
export function partSong(song: Song, turns: Turn[], slot: number): Song {
  const hop = song.hop_ms / 1000;
  const f0_midi = song.f0_midi.map((m, i) => (m != null && inTurns(turns, slot, i * hop) ? m : null));
  const source: Phrase[] = song.phrases.length ? song.phrases : [{ start_s: 0, end_s: song.duration_s }];
  const own = turns.filter((w) => w.slot === slot);
  let phrases: Phrase[] = [];
  for (const p of source) {
    for (const w of own) {
      const a = Math.max(p.start_s, w.start_s);
      const b = Math.min(p.end_s, w.end_s);
      if (b - a > hop) phrases.push({ start_s: a, end_s: b });
    }
  }
  if (!phrases.length) phrases = own.map((w) => ({ start_s: w.start_s, end_s: w.end_s }));
  phrases.sort((x, y) => x.start_s - y.start_s);
  return { ...song, f0_midi, phrases };
}

/** Линия участника для «Прослушать всю песню»: кадры, задержка записи и сдвиг тональности партии. */
export interface CoopPart {
  slot: number;
  frames: PitchFrame[];
  lag: number;
  /** Тональность партии относительно эталона (полутоны, в пределах октавы). */
  shift: number;
}

/**
 * Одно исполнение на двоих: каждая линия звучит только в свои ходы, задержка записи вычтена
 * (как в оценке), тональность подстроена под минус. Голоса чуть разведены влево и вправо.
 */
export function coopLines(turns: Turn[], parts: CoopPart[]): VoiceLine[] {
  return parts.map((p) => ({
    frames: p.frames.map((f) => {
      const t = f.t - p.lag;
      return { t, midi: inTurns(turns, p.slot, t) ? f.midi : null };
    }),
    shift: -p.shift,
    pan: p.slot === 0 ? -0.25 : 0.25,
    gain: 0.9,
  }));
}
