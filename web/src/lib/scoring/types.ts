// Типы результата scoring-core (crates/scoring-core/src/lib.rs). Форма совпадает с прежним
// TypeScript-скорингом; добавлено только поле rawScore.
export interface PitchFrame {
  t: number;
  midi: number | null;
  clarity?: number;
  rms?: number;
}
export interface Phrase {
  start_s: number;
  end_s: number;
}
export interface Song {
  id: string;
  title: string;
  artist: string;
  hop_ms: number;
  duration_s: number;
  f0_midi: (number | null)[];
  phrases: Phrase[];
  lyrics: { t: number; text: string }[];
  backing: string;
}
export interface Axes {
  intervals: number;
  rhythm: number;
  stability: number;
  coverage: number;
}
export type Reason = "pitch" | "rhythm" | "missing";
export interface Moment extends Phrase {
  phrase: number;
  loss: number;
  reason: Reason;
  text: string;
}
export interface ScoreResult {
  score: number;
  rawScore: number;
  axes: Axes;
  lag: number;
  shift: number;
  registerShift: number;
  shiftCurve: number[];
  errors: (number | null)[];
  seconds: { t: number; error: number; coverage: number }[];
  phrases: (Phrase & { score: number; shift: number })[];
  moments: Moment[];
  noteOffsets: { t: number; offset: number }[];
  constantTone: boolean;
}
export interface CorrectionPoint {
  t: number;
  pitch: number | null;
  target: number | null;
}
export type Outcome = "win" | "draw" | "loss";
