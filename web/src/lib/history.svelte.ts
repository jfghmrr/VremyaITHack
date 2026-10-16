// История одиночных попыток: в кабинете — на сервере, у гостя — только в этом браузере.
// Аудио нигде не сохраняется. Сохраняется окончательный балл: точный с сервера или, если
// слова не проверены, браузерный. Это личная статистика, а не доверенный турнирный результат.
import { refreshAchievements, updateAchievements } from "./achievements.svelte";
import { api } from "#lib/api/http.ts";
import { account } from "#lib/api/account.svelte.ts";
import type { AttemptIn } from "#lib/api/types.ts";
import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";
import { ALGORITHM_VERSION } from "#lib/scoring/index.svelte.ts";

export interface Attempt {
  id: string;
  at: string;
  songId: string;
  title: string;
  score: number;
  shift: number;
  axes: ScoreResult["axes"];
  moments: ScoreResult["moments"];
  algorithmVersion?: number | null;
  /** «precise-1», если итог посчитан точной оценкой на сервере; у браузерного балла — null. */
  algorithm?: AttemptIn["algorithm"];
  /** Слова проверены на компьютере команды (точная оценка); иначе балл посчитан браузером. */
  wordsChecked?: boolean;
}

/** Чем посчитан окончательный балл: точной оценкой сервера (тег и проверка слов) или браузером (null). */
export type PreciseTag = { algorithm: string; wordsChecked: boolean } | null;

const GUEST_KEY = "perepev.guestAttempts";

export const saving = $state<{ pending: Attempt | null; error: string; busy: boolean }>({ pending: null, error: "", busy: false });

function attemptOf(song: Song, r: ScoreResult, precise: PreciseTag): Attempt {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    songId: song.id,
    title: song.title,
    score: r.score,
    shift: r.shift,
    axes: r.axes,
    moments: r.moments,
    algorithmVersion: ALGORITHM_VERSION,
    algorithm: precise?.algorithm ?? null,
    wordsChecked: precise?.wordsChecked ?? false,
  };
}

export function guestAttempts(): Attempt[] {
  try {
    return JSON.parse(localStorage.getItem(GUEST_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export async function saveAttempt(song: Song, r: ScoreResult, precise: PreciseTag = null) {
  const a = attemptOf(song, r, precise);
  if (!account.profile) {
    const previous = guestAttempts();
    updateAchievements(previous, [], false);
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify([a, ...guestAttempts()].slice(0, 30)));
    } catch {
      /* хранилище недоступно: история гостя не сохранится */
    }
    updateAchievements([a, ...previous], []);
    return;
  }
  saving.pending = a;
  await retrySave();
}

export async function retrySave() {
  const a = saving.pending;
  if (!a || !account.profile) return;
  saving.busy = true;
  try {
    await api("attempts", { method: "POST", body: { ...a, owner: account.profile.id } });
    void refreshAchievements();
    saving.pending = null;
    saving.error = "";
  } catch (e) {
    saving.error = `Результат не сохранён в кабинете: ${(e as Error).message}`;
  } finally {
    saving.busy = false;
  }
}

// «Побить свой рекорд»: лучшая попытка по песне хранится как каноническая кривая
// (50 мс, без аудио) и может стать призраком следующей попытки.
const BEST_KEY = (id: string) => `perepev.best.${id}`;

export interface Best {
  score: number;
  curve: PitchFrame[];
  at: string;
}

export function bestOf(songId: string): Best | null {
  try {
    const raw = localStorage.getItem(BEST_KEY(songId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function rememberBest(songId: string, score: number, curve: PitchFrame[]) {
  const best = bestOf(songId);
  if (best && best.score >= score) return false;
  try {
    localStorage.setItem(BEST_KEY(songId), JSON.stringify({ score, curve, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}
