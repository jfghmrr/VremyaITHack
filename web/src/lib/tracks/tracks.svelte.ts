// Свои треки (контракт C3): список владельца, загрузка отрывка, удаление. Пока хоть один трек
// ждёт или обрабатывается, список обновляется каждые 3 секунды. Треки живут 24 часа.
import { ApiError, api } from "#lib/api/http.ts";
import { forgetSong } from "#lib/catalog.ts";
import type { TimedWord } from "#lib/lyrics.ts";

export type TrackStatus = "queued" | "running" | "ready" | "failed" | "offline";

export interface OwnTrack {
  id: string;
  title: string;
  language: "ru" | "en";
  status: TrackStatus;
  stage: null | "separating" | "melody" | "words";
  error: string | null;
  expiresAt: string;
}

const POLL_MS = 3000;
// «offline» тоже ждёт: компьютер обработки может включиться, задание остаётся в очереди.
const WAITING = new Set<TrackStatus>(["queued", "running", "offline"]);

export const tracks = $state<{ list: OwnTrack[]; loaded: boolean; error: string }>({ list: [], loaded: false, error: "" });

let watchers = 0;
let timer = 0;

/** Обновляет список; пока страница следит и есть незавершённые треки, повторяет через 3 секунды. */
export async function refreshTracks() {
  clearTimeout(timer);
  try {
    const r = await api<{ tracks: OwnTrack[] }>("tracks");
    tracks.list = r.tracks;
    tracks.error = "";
  } catch (e) {
    tracks.error = e instanceof ApiError && e.status === 404 ? "Свои треки на этом сервере пока недоступны." : (e as Error).message;
  } finally {
    tracks.loaded = true;
  }
  clearTimeout(timer);
  if (watchers > 0 && tracks.list.some((t) => WAITING.has(t.status))) timer = window.setTimeout(() => void refreshTracks(), POLL_MS);
}

/** Следить за списком, пока открыт экран; возвращает функцию отписки. */
export function watchTracks() {
  watchers++;
  void refreshTracks();
  return () => {
    watchers--;
    if (!watchers) clearTimeout(timer);
  };
}

/** Создаёт трек. Звук отправляется отдельно, чтобы после сбоя повторить только его. */
export async function createTrack(title: string, language: "ru" | "en") {
  const { id } = await api<{ id: string }>("tracks", { method: "POST", body: { title, language } });
  return id;
}

/** Отправляет WAV отрывка в созданный трек; сервер ставит задание в очередь. */
export async function sendTrackAudio(id: string, wav: Uint8Array<ArrayBuffer>) {
  let response: Response;
  try {
    response = await fetch(`/api/tracks/${encodeURIComponent(id)}/audio`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "audio/wav", "x-perepev-request": "1" },
      body: wav,
    });
  } catch {
    throw new ApiError("Нет связи с сервером. Попробуй загрузить ещё раз.", 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(typeof data.error === "string" ? data.error : "Сервер не принял отрывок. Попробуй ещё раз.", response.status);
  }
  await refreshTracks();
}

export async function deleteTrack(id: string) {
  await api(`tracks/${encodeURIComponent(id)}`, { method: "DELETE" });
  tracks.list = tracks.list.filter((t) => t.id !== id);
}

/** Сохраняет исправленный текст и времена строк готового трека (только владелец). */
export async function saveLyrics(id: string, body: { lines: { words: TimedWord[] }[] }) {
  const saved = await api<{ lines: { line: number; words: TimedWord[] }[]; masked: number }>(`tracks/${encodeURIComponent(id)}/lyrics`, {
    method: "PUT",
    body,
  });
  forgetSong(`my-${id}`);
  return saved;
}

const STAGES = { separating: "Отделяем голос", melody: "Мелодия", words: "Слова" } as const;

export function statusText(t: OwnTrack): string {
  switch (t.status) {
    case "queued":
      return "В очереди";
    case "running":
      return STAGES[t.stage ?? "separating"];
    case "ready":
      return "Готово — петь";
    case "failed":
      return "Не получилось";
    case "offline":
      return "ПК обработки выключен — ждём";
  }
}

/** «удалится через N ч», не меньше 1 ч, пока трек не удалён. */
export function expiryText(t: OwnTrack, now = Date.now()): string {
  const hours = Math.max(1, Math.ceil((Date.parse(t.expiresAt) - now) / 3_600_000));
  return `удалится через ${hours} ч`;
}
