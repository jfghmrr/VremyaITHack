// Последняя одиночная попытка живёт в памяти вкладки: запись голоса не сохраняется
// и исчезает при перезагрузке, а разбор можно открыть снова, пока вкладка открыта.
import type { Challenge } from "#lib/challenge/codec.ts";
import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}

/** Призрак: чужой вызов из ссылки или своя лучшая попытка. Это записанная линия, не живой соперник. */
export interface Ghost {
  kind: "challenge" | "record";
  name: string;
  curve: PitchFrame[];
}

export const last = $state<{
  song: Song | null;
  frames: PitchFrame[];
  result: ScoreResult | null;
  recording: Recording | null;
  backing: AudioBuffer | null;
  ghost: Ghost | null;
}>({ song: null, frames: [], result: null, recording: null, backing: null, ghost: null });

/** Входящий вызов-призрак из ссылки. */
export const incoming = $state<{ challenge: Challenge | null; error: string }>({ challenge: null, error: "" });
