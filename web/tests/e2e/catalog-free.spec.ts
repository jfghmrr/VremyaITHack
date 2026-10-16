// Свободные песни, добавленные командой `catalog import` (у них есть поле age): каждая
// загружается, проходит проверку микрофона, поётся синтетическим микрофоном и получает оценку.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { CatalogEntry } from "../../src/lib/catalog";
import { fakeMic } from "./fake-mic";

const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL("../../static/songs/index.json", import.meta.url), "utf8"));
const imported = catalog.filter((song) => song.age !== undefined);

test("в каталоге есть добавленные свободные песни", () => {
  expect(imported.length).toBeGreaterThan(0);
});

for (const song of imported) {
  test(`${song.id}: микрофон → пение → оценка`, async ({ page, context }) => {
    test.setTimeout(song.duration_s * 1000 + 90_000);
    await fakeMic(context, song.id, { shift: -3 });
    await page.goto("/songs");
    await expect(page.getByRole("heading", { name: "Выбор песни" })).toBeVisible();
    await page.getByRole("searchbox").fill(song.title);
    await expect(page.getByRole("img", { name: `Возрастная маркировка ${song.age}` }).first()).toBeVisible();
    await page.getByRole("button", { name: `Петь «${song.title}»` }).click();
    await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toBeVisible();
    await page.getByRole("button", { name: "Включить микрофон" }).click();
    await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Пение")).toBeVisible();
    await expect(page).toHaveURL(/\/result$/, { timeout: song.duration_s * 1000 + 40_000 });
    const label = await page.getByLabel(/из 100/).getAttribute("aria-label");
    const score = Number(label!.split(" ")[0]);
    expect(score).toBeGreaterThan(60);
  });
}
