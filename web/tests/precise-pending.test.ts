// Пометка у балла, пока компьютер команды считает итог: у песен без проверки слов
// («wordsCheck»: false в index.json) она не обещает проверку слов.
import { expect, it, vi } from "vitest";
import type { ScoreResult, Song } from "../src/lib/scoring/types";
import type { PerfSession } from "../src/lib/precise/uploader";

vi.mock("#lib/history.svelte.ts", () => ({ saveAttempt: vi.fn(async () => {}) }));

const { settle, precise, pendingNote } = await import("../src/lib/precise/attempt.svelte");

const song = { id: "yamshchik-ne-goni", title: "Ямщик" } as Song;
const result = { score: 80, shift: 0, axes: { intervals: 0.8, rhythm: 0.8, stability: 0.8, coverage: 0.9 }, moments: [] } as unknown as ScoreResult;
// Итог ещё не пришёл: досылка записи не заканчивается.
const waiting = { finish: () => new Promise(() => {}), cancel: () => {}, push: () => {} } as unknown as PerfSession;

it("песня без проверки слов: «уточняем оценку…»", () => {
  settle(song, result, waiting, undefined, "headphones", false);
  expect(precise.status).toBe("pending");
  expect(pendingNote(precise.wordsCheck)).toBe("уточняем оценку…");
});

it("обычная песня: «проверяем слова…»", () => {
  settle({ ...song, id: "cn-earth" }, result, waiting, undefined, "headphones");
  expect(precise.status).toBe("pending");
  expect(pendingNote(precise.wordsCheck)).toBe("проверяем слова…");
});
