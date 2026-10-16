import { expect, it } from "vitest";
import { homePreview } from "../src/lib/home-preview";
import type { CatalogEntry } from "../src/lib/catalog";

const song = (id: string, hasVocals = true): CatalogEntry => ({ id, title: id, artist: "Автор", duration_s: 30, preview: "backing.mp3", hasVocals });
const catalog = [song("first"), song("second"), song("instrumental", false)];

it("магнитофон выбирает последнюю доступную песню по дате, а не по баллу или порядку API", () => {
  const choice = homePreview(catalog, [
    { songId: "first", score: 98, at: "2026-10-16T09:00:00Z" },
    { songId: "second", score: 25, at: "2026-10-16T10:00:00Z" },
    { songId: "first", score: 75, at: "2026-10-16T08:00:00Z" },
  ]);
  expect(choice?.song.id).toBe("second");
  expect(choice?.fromHistory).toBe(true);
});

it("удалённая песня и инструментальная запись не возвращаются в магнитофон из истории", () => {
  expect(homePreview(catalog, [
    { songId: "first", score: 90, at: "2026-10-16T08:00:00Z" },
    { songId: "removed", score: 90, at: "2026-10-16T09:00:00Z" },
    { songId: "instrumental", score: 90, at: "2026-10-16T10:00:00Z" },
  ])?.song.id).toBe("first");
});

it("без пригодной истории играет первый вокальный трек; пустой каталог не имеет запасной минусовки", () => {
  expect(homePreview(catalog, [])).toEqual({ song: catalog[0], fromHistory: false });
  expect(homePreview(catalog, [{ songId: "second", score: 10, at: "invalid" }])?.fromHistory).toBe(false);
  expect(homePreview([song("instrumental", false)], [])).toBeNull();
  expect(homePreview([{ ...song("unavailable"), preview: null }], [])).toBeNull();
});
