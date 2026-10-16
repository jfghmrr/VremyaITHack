// Каталог и эталоны песен: те же файлы songs/index.json и <id>/reference.json, что и раньше.
// Свой трек (id «my-<uuid>») лежит не в /songs, а отдаётся владельцу через /api/tracks/<uuid>/files/.
import type { SongInfo } from "#lib/api/types.ts";
import type { Song } from "#lib/scoring/types.ts";

/** uuid своего трека или null для песни каталога. */
export const ownTrack = (id: string) => (id.startsWith("my-") ? id.slice(3) : null);

export const asset = (id: string, file: string) => {
  const path = file.split("/").map(encodeURIComponent).join("/");
  const own = ownTrack(id);
  return own ? `/api/tracks/${encodeURIComponent(own)}/files/${path}` : `/songs/${encodeURIComponent(id)}/${path}`;
};

let catalog: Promise<CatalogEntry[]> | null = null;
const songs = new Map<string, Promise<Song>>();

export function loadCatalog(): Promise<CatalogEntry[]> {
  catalog ??= fetch("/songs/index.json").then((r) => {
    if (!r.ok) throw new Error("Не удалось загрузить песни. Обнови страницу.");
    return r.json();
  });
  catalog.catch(() => (catalog = null));
  return catalog;
}

export function loadSong(id: string): Promise<Song> {
  let p = songs.get(id);
  if (!p) {
    p = fetch(asset(id, "reference.json")).then(async (r) => {
      if (!r.ok) throw new Error("Эталон песни не найден. Выбери другую песню.");
      const song: Song = await r.json();
      // Эталон своего трека создаёт компьютер обработки; в игре трек называется своим id.
      if (ownTrack(id)) song.id = id;
      if (
        song.hop_ms !== 10 ||
        !Array.isArray(song.f0_midi) ||
        song.duration_s > 60 ||
        song.duration_s <= 0 ||
        song.id !== id ||
        song.f0_midi.length > 6001
      )
        throw new Error("Неподдерживаемый эталон. Нужен фрагмент до 60 секунд с шагом 10 мс.");
      return song;
    });
    p.catch(() => songs.delete(id));
    songs.set(id, p);
  }
  return p;
}

/** Версия эталона — первые 12 символов SHA-256 reference.json, как на сервере. */
export async function songVersion(id: string): Promise<string> {
  const r = await fetch(asset(id, "reference.json"));
  const digest = await crypto.subtle.digest("SHA-256", await r.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** Запись каталога с упрощённым контуром мелодии для мини-графика. */
export type CatalogEntry = SongInfo & {
  contour?: (number | null)[];
  wordTiming?: string;
  /** Только реальные записи с поющим исполнителем, не синтезированный ориентир. */
  hasVocals?: boolean;
  language?: "ru" | "en";
  license?: string;
  credits?: string;
  /** Возрастная маркировка песни (436-ФЗ); без поля — 0+. */
  age?: string;
  /** Есть instrumental.mp3 и guide.mp3 (отделённый голос), выровненные с backing.mp3. */
  stems?: boolean;
};

/** Запись для экрана пения: песня каталога или свой трек (у него всегда есть дорожки и слова). */
export function entryFor(id: string, list: CatalogEntry[]): CatalogEntry | undefined {
  if (!ownTrack(id)) return list.find((entry) => entry.id === id);
  return { id, title: "", artist: "", duration_s: 0, hasVocals: true, stems: true, preview: "backing.mp3", wordTiming: "lyrics.words.json" };
}

export const catalogSections = ["Все", "Русские", "English"] as const;
export type CatalogSection = (typeof catalogSections)[number];

export function filterCatalog(list: CatalogEntry[], section: CatalogSection, query: string): CatalogEntry[] {
  const normalize = (text: string) => text.toLocaleLowerCase().replaceAll("ё", "е");
  const search = normalize(query.trim());
  return list.filter((song) => {
    const matchesSection = song.hasVocals === true && (section === "Все"
      || (section === "Русские" && song.language === "ru")
      || (section === "English" && song.language === "en"));
    return matchesSection && (!search || normalize(`${song.title} ${song.artist}`).includes(search));
  });
}
