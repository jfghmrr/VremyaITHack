import type { Song, SongInfo } from "../types";
export const asset = (id: string, file: string) =>
  `${import.meta.env.BASE_URL}songs/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`;
export async function loadCatalog(): Promise<SongInfo[]> {
  const r = await fetch(`${import.meta.env.BASE_URL}songs/index.json`);
  if (!r.ok) throw new Error("Не удалось загрузить песни. Обнови страницу.");
  return r.json();
}
export async function loadSong(id: string): Promise<Song> {
  const r = await fetch(asset(id, "reference.json"));
  if (!r.ok) throw new Error("Эталон песни не найден.");
  const song: Song = await r.json();
  if (
    song.hop_ms !== 10 ||
    !Array.isArray(song.f0_midi) ||
    song.duration_s > 60 ||
    song.duration_s <= 0 ||
    song.id !== id ||
    song.f0_midi.length > 6001
  )
    throw new Error(
      "Неподдерживаемый эталон. Нужен фрагмент до 60 секунд с шагом 10 мс.",
    );
  return song;
}
export async function loadBacking(ctx: AudioContext, song: Song) {
  const response = await fetch(asset(song.id, song.backing));
  if (!response.ok)
    throw new Error("Минусовка не загрузилась. Проверь соединение.");
  return ctx.decodeAudioData(await response.arrayBuffer());
}
