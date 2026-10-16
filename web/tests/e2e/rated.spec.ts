import { expect, test } from "@playwright/test";
import { player } from "./helpers";
import { shoot } from "./shoot";

test("рейтинговая очередь: поиск, отмена, подбор, подтверждение, MMR на калибровке", async ({ browser }) => {
  const a = await player(browser, "Вера", "cn-earth", { shift: -3, followLoadedSong: true });
  const b = await player(browser, "Глеб", "cn-earth", { shift: 2, followLoadedSong: true, errors: [[300, 700, 1.7]] });
  // Очередь могла остаться от прошлых прогонов: в ней только эти двое новых игроков калибровки.
  await a.page.goto("/duels");
  await a.page.getByRole("button", { name: "Найти соперника" }).click();
  await expect(a.page.getByText(/Ищем соперника/)).toBeVisible();
  await expect(a.page.getByText(/Пул калибровки/)).toBeVisible();
  await expect(a.page.getByText(/±80 MMR/)).toBeVisible();
  await shoot(a.page, "duels-search", [[1366, 768], [800, 768]]);
  // Отмена и повторный вход: повтор запроса не создаёт вторую заявку.
  await a.page.getByRole("button", { name: "Отменить поиск" }).click();
  await expect(a.page.getByRole("button", { name: "Найти соперника" })).toBeVisible();
  await a.page.getByRole("button", { name: "Найти соперника" }).click();
  await expect(a.page.getByText(/Ищем соперника/)).toBeVisible();

  await b.page.goto("/duels");
  await b.page.getByRole("button", { name: "Найти соперника" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Соперник найден" })).toBeVisible({ timeout: 15_000 });
  await expect(a.page.getByText("Калибровка 0/10").first()).toBeVisible();
  await shoot(a.page, "duel-found", [[1366, 768]]);
  for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Принять" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  // Песню выбирает сервер; генератор микрофона «поёт» ту, что пришла.
  for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Я готов" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 70_000 });
  await expect(a.page.getByText("Рейтинговая дуэль").first()).toBeVisible();
  const rating = async (p: typeof a.page) => p.evaluate(async () => (await (await fetch("/api/rating")).json()) as { mmr: number; ratedMatches: number; calibrating: boolean });
  const [ra, rb] = [await rating(a.page), await rating(b.page)];
  expect(ra.ratedMatches).toBe(1);
  expect(rb.ratedMatches).toBe(1);
  expect(ra.calibrating).toBe(true);
  // K = 40 на калибровке, равные MMR: ±20 (или 0 при ничьей). Сумма сохраняется.
  expect(ra.mmr + rb.mmr).toBe(2000);
  expect([980, 1000, 1020]).toContain(ra.mmr);
  await a.page.getByRole("button", { name: "Сравнить по осям" }).click();
  await expect(a.page.getByText(/рейтинг [+−]20|Калибровка 1\/10/).first()).toBeVisible();
  await a.context.close();
  await b.context.close();
});
