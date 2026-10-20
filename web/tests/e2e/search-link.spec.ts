// Кнопка поиска в шапке (лупа): страница песен открывается сверху, поле поиска в фокусе.
// Владелец (скрин 2): страница открывалась «криво посередине» — ссылка /songs#search
// прокручивала к полю поиска с id="search", и шапка с вкладками уезжала за край окна.
import { expect, test } from "@playwright/test";
import { player } from "./helpers";

for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`лупа в шапке: «Песни» открываются сверху, курсор в поле поиска (${size.width}×${size.height})`, async ({ browser }) => {
    const a = await player(browser, "Ищущий", "cn-earth", {});
    await a.page.setViewportSize(size);
    await a.page.goto("/duels");
    await expect(a.page.getByRole("heading", { name: "Найти соперника" })).toBeVisible();
    await a.page.getByRole("link", { name: "Поиск песни" }).click();
    await expect(a.page).toHaveURL(/\/songs#search$/);
    await expect(a.page.locator("#search")).toBeFocused();
    await a.page.waitForTimeout(500);
    expect(await a.page.evaluate(() => scrollY), "страница не прокручена к полю").toBe(0);
    // Вкладки на месте; на телефоне они в меню, там проверяется вся шапка.
    if (size.width >= 800) await expect(a.page.getByRole("navigation", { name: "Основная навигация" })).toBeInViewport();
    else await expect(a.page.locator("header.top")).toBeInViewport();
    await expect(a.page.locator("#search")).toBeInViewport();
    // Повторное нажатие на самой странице песен тоже возвращает наверх.
    await a.page.evaluate(() => scrollTo(0, 400));
    await a.page.getByRole("link", { name: "Поиск песни" }).click();
    await a.page.waitForTimeout(500);
    expect(await a.page.evaluate(() => scrollY)).toBe(0);
    await expect(a.page.locator("#search")).toBeFocused();
    await a.page.screenshot({ path: `test-results/search-link-${size.width}.png` });
    await a.context.close();
  });
}
