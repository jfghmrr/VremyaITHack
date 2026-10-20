import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogSections, filterCatalog, ownTrack, type CatalogEntry } from "../src/lib/catalog";
import { parseWordTiming } from "../src/lib/lyrics";
import type { Song } from "../src/lib/scoring/types";

const root = new URL("../static/songs/", import.meta.url);
const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL("index.json", root), "utf8"));
const allowedLicenses = new Map([
  ["CC BY 4.0", "/licenses/by/4.0/"],
  ["CC BY-SA 4.0", "/licenses/by-sa/4.0/"],
  ["CC BY 3.0 US", "/licenses/by/3.0/us/"],
  ["CC BY 3.0", "/licenses/by/3.0/"],
  ["CC BY-SA 3.0", "/licenses/by-sa/3.0/"],
  ["CC0 1.0", "/publicdomain/zero/1.0/"],
  // Записи в общественном достоянии (федеральные записи США, старые фонограммы) — знак Public Domain Mark.
  ["Public domain", "/publicdomain/mark/1.0/"],
]);

type Credits = {
  id: string;
  title: string;
  artist: string;
  credits: string | string[];
  language: "ru" | "en";
  source: string;
  license: string;
  licenseUrl: string;
  clip: { start_s: number; end_s: number; lead_s: number };
  reviewedAt: string;
  sourceSha256: string;
  files: Record<string, string>;
  preparation: unknown;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
const syllables = new Set(["ла", "ля", "та", "на", "мм", "la", "na", "da"]);

describe("опубликованный каталог с настоящим вокалом", () => {
  it("содержит не меньше двадцати уникальных песен и по десять на каждом языке", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(20);
    expect(new Set(catalog.map((song) => song.id)).size).toBe(catalog.length);
    for (const language of ["ru", "en"])
      expect(catalog.filter((song) => song.language === language).length).toBeGreaterThanOrEqual(10);
    expect(catalog.every((song) => song.hasVocals === true)).toBe(true);
    expect(catalogSections).toEqual(["Все", "Русские", "Английские"]);
  });

  it("страница /legal/music указывает каждую песню каталога с атрибуцией и изменениями", () => {
    const legal: Array<Record<string, string>> = JSON.parse(readFileSync(new URL("../src/lib/legal/vocal-music.json", import.meta.url), "utf8"));
    expect(legal.map((entry) => entry.id)).toEqual(catalog.map((song) => song.id));
    for (const entry of legal) {
      const credits = JSON.parse(readFileSync(new URL(`${entry.id}/CREDITS.json`, root), "utf8"));
      for (const key of ["title", "artist", "language", "source", "license", "licenseUrl"]) expect(entry[key]).toBe(credits[key]);
      expect(entry.credits.trim().length).toBeGreaterThan(3);
      expect(entry.changes.trim().length).toBeGreaterThan(10);
    }
  });

  for (const info of catalog) {
    it(`${info.id}: запись, слова, эталон и атрибуция согласованы`, () => {
      expect(info.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      // «my-<id>» — свой трек пользователя: сайт и API загрузят его не из каталога.
      expect(ownTrack(info.id)).toBeNull();
      expect(info.hasVocals).toBe(true);
      expect(["ru", "en"]).toContain(info.language);
      expect(info.title.trim()).not.toBe("");
      expect(info.artist.trim()).not.toBe("");
      expect(info.preview).toBe("backing.mp3");
      expect(info.wordTiming).toBe("lyrics.words.json");
      expect(info.credits).toBe("CREDITS.json");
      if (info.age !== undefined) expect(["0+", "6+"]).toContain(info.age);
      if (info.stems) for (const stem of ["instrumental.mp3", "guide.mp3"]) expect(readFileSync(new URL(`${info.id}/${stem}`, root)).length).toBeGreaterThan(4096);

      const dir = new URL(`${info.id}/`, root);
      const song: Song = JSON.parse(readFileSync(new URL("reference.json", dir), "utf8"));
      const credits: Credits = JSON.parse(readFileSync(new URL("CREDITS.json", dir), "utf8"));
      const timing = parseWordTiming(JSON.parse(readFileSync(new URL("lyrics.words.json", dir), "utf8")), song);
      for (const key of ["id", "title", "artist"] as const) {
        expect(song[key]).toBe(info[key]);
        expect(credits[key]).toBe(info[key]);
      }
      expect(credits.language).toBe(info.language);
      expect(credits.license).toBe(info.license);
      expect(allowedLicenses.has(credits.license)).toBe(true);
      const licenseUrl = new URL(credits.licenseUrl);
      expect(licenseUrl.protocol).toBe("https:");
      expect(licenseUrl.hostname).toBe("creativecommons.org");
      expect(licenseUrl.pathname).toBe(allowedLicenses.get(credits.license));
      expect(new URL(credits.source).protocol).toBe("https:");
      const authors = Array.isArray(credits.credits) ? credits.credits : [credits.credits];
      expect(authors.length).toBeGreaterThan(0);
      for (const author of authors) {
        expect(typeof author).toBe("string");
        expect(author.trim().length).toBeGreaterThan(3);
      }
      expect(Number.isFinite(Date.parse(credits.reviewedAt))).toBe(true);
      expect(credits.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(credits.preparation)?.length ?? 0).toBeGreaterThan(10);

      expect(song.duration_s).toBe(info.duration_s);
      expect(song.duration_s).toBeGreaterThan(10);
      expect(song.duration_s).toBeLessThanOrEqual(60);
      expect(song.backing).toBe("backing.mp3");
      expect(song.hop_ms).toBe(10);
      expect(Math.abs(song.f0_midi.length * song.hop_ms / 1000 - song.duration_s)).toBeLessThanOrEqual(.02);
      const voiced = song.f0_midi.filter((midi): midi is number => midi !== null);
      expect(voiced.length).toBeGreaterThan(song.f0_midi.length * .1);
      expect(voiced.every((midi) => Number.isFinite(midi) && midi >= 0 && midi <= 127)).toBe(true);
      expect(credits.clip.start_s).toBeGreaterThanOrEqual(0);
      expect(credits.clip.end_s).toBeGreaterThan(credits.clip.start_s);
      expect(credits.clip.lead_s).toBeGreaterThanOrEqual(0);
      expect(credits.clip.lead_s).toBeLessThan(song.duration_s);
      expect(credits.clip.end_s - credits.clip.start_s + credits.clip.lead_s).toBeCloseTo(song.duration_s, 2);
      let phraseEnd = 0;
      for (const phrase of song.phrases) {
        expect(phrase.start_s).toBeGreaterThanOrEqual(phraseEnd);
        expect(phrase.end_s).toBeGreaterThan(phrase.start_s);
        expect(phrase.end_s).toBeLessThanOrEqual(song.duration_s);
        phraseEnd = phrase.end_s;
      }

      const textWords = words(song.lyrics.map((line) => line.text).join(" "));
      expect(textWords.length).toBeGreaterThanOrEqual(12);
      expect(new Set(textWords).size).toBeGreaterThanOrEqual(8);
      expect(timing.lines.length).toBeGreaterThanOrEqual(2);
      for (const line of song.lyrics) {
        const tokens = words(line.text);
        expect(tokens.some((token) => !syllables.has(token))).toBe(true);
      }
      expect(textWords.some((word) => info.language === "ru" ? /[а-яё]/u.test(word) : /[a-z]/u.test(word))).toBe(true);

      // Хеши связывают фактически опубликованные файлы с проверенными credits.
      for (const file of [song.backing, "reference.json", "lyrics.words.json"]) {
        expect(credits.files[file]).toMatch(/^[a-f0-9]{64}$/);
        expect(sha256(readFileSync(new URL(file, dir)))).toBe(credits.files[file]);
      }
      for (const [file, hash] of Object.entries(credits.files)) {
        expect(file).toMatch(/^[\w.-]+$/);
        expect(file).not.toBe("CREDITS.json");
        expect(sha256(readFileSync(new URL(file, dir)))).toBe(hash);
      }
      const audio = readFileSync(new URL(song.backing, dir));
      expect(audio.length).toBeGreaterThan(4096);
      // Поддержаны ID3 и MP3 без тега. Метаданные не доказывают наличие голоса:
      // само исполнение и текст проверяются при подготовке каталога.
      expect(audio.subarray(0, 3).toString() === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)).toBe(true);
    });
  }
});

describe("поиск и языковые фильтры", () => {
  const example = (id: string, title: string, artist: string, language: "ru" | "en", hasVocals = true): CatalogEntry => ({
    id, title, artist, language, hasVocals, duration_s: 30,
  });
  const examples = [
    example("ru-one", "Над землёю", "Complex Numbers", "ru"),
    example("en-one", "Follow the Road", "Josh Woodward", "en"),
    example("old-minus", "Над землёю — минус", "Complex Numbers", "ru", false),
    { ...example("old-no-flag", "Старый учебный эталон", "Автор", "ru"), hasVocals: undefined },
  ];

  it("даже раздел «Все» не показывает инструментальный трек", () => {
    expect(filterCatalog(examples, "Все", "").map((song) => song.id)).toEqual(["ru-one", "en-one"]);
    expect(filterCatalog(examples, "Русские", "").map((song) => song.id)).toEqual(["ru-one"]);
    expect(filterCatalog(examples, "Английские", "").map((song) => song.id)).toEqual(["en-one"]);
  });
  it("ищет название без различия ё/е и регистра, а также автора", () => {
    expect(filterCatalog(examples, "Все", "  ЗЕМЛЕЮ  ").map((song) => song.id)).toEqual(["ru-one"]);
    expect(filterCatalog(examples, "Все", "woodward").map((song) => song.id)).toEqual(["en-one"]);
    expect(filterCatalog(examples, "Английские", "follow").map((song) => song.id)).toEqual(["en-one"]);
  });
  it("не смешивает языковой фильтр с результатами поиска и возвращает пустой список", () => {
    expect(filterCatalog(examples, "Русские", "woodward")).toEqual([]);
    expect(filterCatalog(examples, "Все", "Несуществующее название 987")).toEqual([]);
  });
});
