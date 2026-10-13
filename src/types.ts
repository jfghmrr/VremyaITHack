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
export interface SongInfo {
  id: string;
  title: string;
  artist: string;
  duration_s: number;
  tag: string;
  preview?: string;
}
export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}
