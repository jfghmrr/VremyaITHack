import { expect, test } from "@playwright/test";
import { duelScores, matchIdOf, player, sentCommands, singFreshRematch } from "./helpers";
import { shoot } from "./shoot";

test("рейтинговая очередь: поиск, отмена, подбор, подтверждение, MMR на калибровке", async ({ browser }) => {
  const a = await player(browser, "Вера", "cn-earth", { shift: -3, followLoadedSong: true });
  const b = await player(browser, "Глеб", "cn-earth", { shift: 2, followLoadedSong: true, errors: [[300, 700, 1.7]] });
  const sent = sentCommands(a.page);
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
  // Сцена: слова песни над графиком, «Выйти» — обычная кнопка справа, понятная строка отправки.
  await expect(a.page.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
  const lyrics = a.page.getByRole("region", { name: "Слова песни" });
  await expect(lyrics).toBeVisible();
  await expect(lyrics.locator(".now")).not.toBeEmpty();
  const exit = await a.page.getByRole("button", { name: "Выйти" }).boundingBox();
  expect(exit!.width, "«Выйти» не растягивается на полстраницы").toBeLessThan(200);
  await expect(a.page.getByText(/Твоя линия: отправлено \d+ из \d+ точ/)).toBeVisible();
  await expect(a.page.getByText(/в очереди/)).toHaveCount(0);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 70_000 });
  await expect(a.page.getByRole("heading", { name: /^Рейтинговая дуэль · «.+»$/ })).toBeVisible();
  const rating = async (p: typeof a.page) => p.evaluate(async () => (await (await fetch("/api/rating")).json()) as { mmr: number; ratedMatches: number; calibrating: boolean });
  const [ra, rb] = [await rating(a.page), await rating(b.page)];
  expect(ra.ratedMatches).toBe(1);
  expect(rb.ratedMatches).toBe(1);
  expect(ra.calibrating).toBe(true);
  // K = 40 на калибровке, равные MMR: ±20 (или 0 при ничьей). Сумма сохраняется.
  expect(ra.mmr + rb.mmr).toBe(2000);
  expect([980, 1000, 1020]).toContain(ra.mmr);
  // Разбор: оси обоих, вывод, прослушивание линий синтезированным голосом.
  await a.page.getByRole("button", { name: "Разбор и прослушивание" }).click();
  await expect(a.page.getByText(/рейтинг [+−]20|Калибровка 1\/10/).first()).toBeVisible();
  const table = a.page.getByRole("table", { name: "Сравнение по осям оценки" });
  for (const axis of ["Интервалы", "Ритм", "Устойчивость", "Покрытие", "Итоговый балл"]) await expect(table.getByRole("rowheader", { name: new RegExp(axis) })).toBeVisible();
  await expect(a.page.getByRole("button", { name: "▶ Оба вместе" })).toBeEnabled();
  await a.page.getByRole("button", { name: "▶ Как спел ты" }).click();
  await expect(a.page.getByRole("button", { name: "▶ Как спел ты" })).toHaveAttribute("aria-pressed", "true");
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await a.page.screenshot({ path: "test-results/rated-analysis.png", fullPage: true });
  await a.page.getByRole("button", { name: "← К результату" }).click();

  // «К дуэлям» уводит на «Дуэли» и не возвращает на итог сыгранного матча.
  await b.page.getByRole("link", { name: "К дуэлям" }).click();
  await expect(b.page).toHaveURL(/\/duels$/);
  await b.page.waitForTimeout(1500);
  await expect(b.page).toHaveURL(/\/duels$/);
  await expect(b.page.getByRole("heading", { name: "Найти соперника" })).toBeVisible();

  // Реванш после рейтинговой дуэли: та же песня, без рейтинга, оба в одной комнате.
  const firstId = matchIdOf(a.page)!;
  const [firstScore] = await duelScores(a.page);
  await a.page.getByRole("button", { name: "Реванш без рейтинга" }).click();
  await expect(a.page.getByRole("heading", { name: "Реванш: ждём соперника" })).toBeVisible();
  await expect(a.page.getByText(/Приглашение уже отправлено/)).toBeVisible();
  await expect(b.page.getByText(/Соперник зовёт на реванш/)).toBeVisible({ timeout: 10_000 });
  await b.page.getByRole("link", { name: "Принять реванш" }).click();
  for (const p of [a.page, b.page]) {
    await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible({ timeout: 15_000 });
    await expect(p.getByRole("heading", { name: /^Дуэль с другом, без рейтинга · «.+»$/ })).toBeVisible();
  }
  // Нажавший «Реванш без рейтинга» поёт реванш до итога: новая попытка, рейтинг не меняется.
  await singFreshRematch({ presser: a.page, other: b.page, sent, firstId, firstScore: Number(firstScore) });
  await expect(a.page.getByRole("heading", { name: /^Дуэль с другом, без рейтинга · «.+»$/ })).toBeVisible();
  expect((await rating(a.page)).ratedMatches).toBe(1);
  // Ещё один реванш (после дружеской дуэли) и выход с «Подготовки» на «Дуэли».
  await a.page.getByRole("button", { name: "Реванш", exact: true }).click();
  await expect(a.page.getByRole("heading", { name: "Реванш: ждём соперника" })).toBeVisible();
  await expect(b.page.getByText(/Вера зовёт на реванш/).first()).toBeVisible({ timeout: 10_000 });
  await b.page.getByRole("link", { name: "Принять реванш" }).first().click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "← К дуэлям" }).click();
  await expect(a.page).toHaveURL(/\/duels$/);
  await a.context.close();
  await b.context.close();
});
