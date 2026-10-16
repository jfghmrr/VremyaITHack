import { expect, test } from "@playwright/test";
import { player } from "./helpers";
import { shoot } from "./shoot";

test("живая дуэль с другом: комната, готовность, общий старт, одинаковый результат", async ({ browser }) => {
  // Обе вкладки поют выбранный вокальный фрагмент в разных тональностях.
  const a = await player(browser, "Аня", "cn-earth", { shift: -5 });
  const b = await player(browser, "Борис", "cn-earth", { shift: 4, errors: [[200, 400, 1.6], [1100, 1300, -1.8]] });

  await a.page.goto("/duels");
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  const code = (await a.page.locator(".code").textContent())!.trim();
  await shoot(a.page, "duel-room", [[1366, 768]]);

  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  await shoot(b.page, "duel-ready", [[1366, 768]]);
  await a.page.getByRole("button", { name: "Я готов" }).click();
  await b.page.getByRole("button", { name: "Я готов" }).click();

  for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
  await a.page.waitForTimeout(10_000);
  await a.page.screenshot({ path: "../docs/screens/duel-stage-1366.png" });
  // Индивидуальной паузы нет: пробел ничего не останавливает.
  await a.page.keyboard.press("Space");

  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 60_000 });
  await expect(a.page.getByRole("heading", { name: "Победа" })).toBeVisible();
  await expect(b.page.getByRole("heading", { name: "Поражение" })).toBeVisible();
  const scores = async (p: typeof a.page) => (await p.locator(".col .score").allTextContents()).map((s) => s.trim());
  const sa = await scores(a.page);
  const sb = await scores(b.page);
  // Одинаковый подтверждённый результат: колонки зеркальны.
  expect(sa).toEqual([sb[1], sb[0]]);
  expect(Number(sa[0])).toBeGreaterThan(90);
  await a.page.waitForTimeout(1000);
  await shoot(a.page, "duel-result", [[1366, 768], [1920, 1080]]);
  await a.page.getByRole("button", { name: "Сравнить по осям" }).click();
  await expect(a.page.getByRole("heading", { name: "Разбор дуэли" })).toBeVisible();
  await shoot(a.page, "duel-analysis", [[1366,768]]);
  await a.page.getByRole("button", { name: "← К результату" }).click();
  await a.page.getByRole("button", { name: "Реванш", exact: true }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  await b.page.getByRole("link", { name: "Принять реванш" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  await a.page.getByRole("button", { name: "← К дуэлям" }).click();
  await expect(a.page).toHaveURL(/\/duels$/);
  await a.context.close();
  await b.context.close();
});
