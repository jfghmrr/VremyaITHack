import type { PitchFrame, ScoreResult, Song } from "./types";

export type Request =
  | { id: number; kind: "score"; frames: PitchFrame[]; song: Song }
  | { id: number; kind: "canonical"; frames: PitchFrame[]; duration: number }
  | { id: number; kind: "correction"; frames: PitchFrame[]; song: Song; result: ScoreResult }
  | { id: number; kind: "outcome"; a: number; b: number };

export type Response =
  | { id: number; ok: true; value: unknown; ms: number }
  | { id: number; ok: false; error: string };
