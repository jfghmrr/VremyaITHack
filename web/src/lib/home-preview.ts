import type { CatalogEntry } from "#lib/catalog.ts";

export type SungPerformance = { songId: string; score: number; at: string | null };

/** История может включать удалённые песни. Выбираем последнюю доступную запись с вокалом. */
export function homePreview(catalog: CatalogEntry[], performances: SungPerformance[]) {
  const playable = catalog.filter(song => song.hasVocals === true && Boolean(song.preview));
  const byId = new Map(playable.map(song => [song.id, song]));
  let latest: CatalogEntry | undefined;
  let latestTime = -Infinity;
  for (const performance of performances) {
    const song = byId.get(performance.songId);
    const time = performance.at ? Date.parse(performance.at) : NaN;
    if (song && Number.isFinite(time) && time > latestTime) {
      latest = song;
      latestTime = time;
    }
  }
  return latest ? { song: latest, fromHistory: true } : playable[0] ? { song: playable[0], fromHistory: false } : null;
}
