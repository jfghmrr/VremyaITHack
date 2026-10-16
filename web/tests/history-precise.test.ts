// История попыток (спецификация §5.6): точный итог сохраняется с тегом алгоритма
// «precise-1» и признаком проверки слов; браузерный балл — без тега, слова не проверены.
import { beforeEach, expect, it, vi } from "vitest";
import type { ScoreResult, Song } from "../src/lib/scoring/types";

const sent: { path: string; body: Record<string, unknown> }[] = [];
vi.mock("#lib/api/http.ts", () => ({
  api: vi.fn(async (path: string, init: { body: Record<string, unknown> }) => {
    sent.push({ path, body: init.body });
    return { ok: true };
  }),
}));
vi.mock("#lib/api/account.svelte.ts", () => ({ account: { profile: { id: "user-1" } } }));
vi.mock("#lib/scoring/index.svelte.ts", () => ({ ALGORITHM_VERSION: 1 }));
vi.mock("../src/lib/achievements.svelte", () => ({ refreshAchievements: async () => {}, updateAchievements: () => {} }));

const { saveAttempt } = await import("../src/lib/history.svelte");

const song = { id: "cn-earth", title: "Земное притяжение" } as Song;
const result = { score: 87.5, shift: -2, axes: { intervals: 0.9, rhythm: 0.8, stability: 0.85, coverage: 0.95 }, moments: [] } as unknown as ScoreResult;

beforeEach(() => {
  sent.length = 0;
});

it("точный итог: тег precise-1 и признак проверки слов уходят на сервер", async () => {
  await saveAttempt(song, result, { algorithm: "precise-1", wordsChecked: true });
  expect(sent).toHaveLength(1);
  expect(sent[0].path).toBe("attempts");
  expect(sent[0].body).toMatchObject({ songId: "cn-earth", score: 87.5, algorithm: "precise-1", wordsChecked: true, owner: "user-1" });
});

it("точный итог без слов (в песне нет текста): тег есть, слова не проверены", async () => {
  await saveAttempt(song, result, { algorithm: "precise-1", wordsChecked: false });
  expect(sent[0].body).toMatchObject({ algorithm: "precise-1", wordsChecked: false });
});

it("браузерный балл: без тега точной оценки, слова не проверены", async () => {
  await saveAttempt(song, result, null);
  expect(sent[0].body.algorithm ?? null).toBeNull();
  expect(sent[0].body.wordsChecked).toBe(false);
});
