// Дуэль на телефонах (портрет и ландшафт): на сцене видны слова, дека с «Выйти» и график;
// на итоге подзаголовок вида дуэли читается на тёмном фоне; разбор помещается по ширине.
import { expect, test, type Page } from "@playwright/test";
import { player } from "./helpers";

const phone = (width: number, height: number) => ({ viewport: { width, height }, isMobile: true, hasTouch: true });

// На телефоне (isMobile) широкая страница растягивает окно раскладки, поэтому ширина
// документа сравнивается с шириной экрана, а не с innerWidth.
async function noSideScroll(page: Page, where: string) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${where}: горизонтальная прокрутка`).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("дуэль с другом на телефонах: слова, дека, график, итог и разбор", async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await player(browser, "Аня", "cn-earth", { shift: -5 }, phone(390, 844));
  const b = await player(browser, "Борис", "cn-earth", { shift: 4, errors: [[200, 400, 1.6]] }, phone(844, 390));
  await a.page.goto("/duels");
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  const code = (await a.page.locator(".code").textContent())!.trim();
  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  await a.page.screenshot({ path: "test-results/duel-phone-ready-390.png" });
  for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Я готов" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
  await a.page.waitForTimeout(7_000);
  for (const [p, tag] of [[a.page, "390x844"], [b.page, "844x390"]] as const) {
    await p.screenshot({ path: `test-results/duel-phone-stage-${tag}.png` });
    await expect(p.getByRole("region", { name: "Слова песни" }).locator(".now"), `${tag}: строка песни`).toBeInViewport();
    await expect(p.getByRole("button", { name: "Выйти" }), `${tag}: «Выйти»`).toBeInViewport();
    const roll = await p.locator(".stage .roll").boundingBox();
    expect(roll!.height, `${tag}: высота графика`).toBeGreaterThanOrEqual(tag === "390x844" ? 260 : 150);
    expect(roll!.y + roll!.height, `${tag}: график в окне`).toBeLessThanOrEqual((p.viewportSize()?.height ?? 0) + 1);
    await noSideScroll(p, tag);
  }
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 60_000 });
  await a.page.waitForTimeout(800);
  for (const [p, tag] of [[a.page, "390x844"], [b.page, "844x390"]] as const) {
    await expect(p.getByRole("heading", { name: /^Дуэль с другом, без рейтинга · «.+»$/ })).toBeVisible();
    await p.screenshot({ path: `test-results/duel-phone-result-${tag}.png`, fullPage: true });
    await noSideScroll(p, `${tag} итог`);
    await p.getByRole("button", { name: "Разбор и прослушивание" }).click();
    await expect(p.getByRole("table", { name: "Сравнение по осям оценки" })).toBeVisible();
    await p.screenshot({ path: `test-results/duel-phone-analysis-${tag}.png`, fullPage: true });
    await noSideScroll(p, `${tag} разбор`);
  }
  await a.context.close();
  await b.context.close();
});
