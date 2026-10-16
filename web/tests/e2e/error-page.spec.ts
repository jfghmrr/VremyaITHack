import { expect, test, type Locator } from "@playwright/test";

// Несуществующий адрес: русская страница в стиле комнаты, навигация и подвал на месте.
test("страница 404: русский текст, выход на главную и к песням", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Такой страницы нет" })).toBeVisible();
  await expect(page.getByRole("link", { name: "На главную" })).toBeVisible();
  await expect(page.getByRole("link", { name: "К песням" })).toBeVisible();
  await expect(page).toHaveTitle(/Страница не найдена/);
  await expect(page.getByText("Not Found")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Документы" })).toBeVisible();
  await page.getByRole("link", { name: "К песням" }).click();
  await expect(page).toHaveURL(/\/songs$/);
  await expect(page.getByRole("heading", { name: "Выбор песни" })).toBeVisible();
});

// Телефон (сенсорный экран, pointer: coarse): кнопки-ссылки и «Попробовать ещё раз» не ниже 44 px.
test.describe("страница ошибки на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const tall = async (locator: Locator, what: string) => {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box?.height ?? 0, `${what}: высота цели нажатия`).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, `${what}: ширина цели нажатия`).toBeGreaterThanOrEqual(44);
  };

  test("404: «На главную» и «К песням» не ниже 44 px", async ({ page }) => {
    await page.goto("/no-such-page");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "эмуляция сенсорного экрана").toBe(true);
    await expect(page.getByRole("heading", { name: "Такой страницы нет" })).toBeVisible();
    await tall(page.locator(".lost").getByRole("link", { name: "На главную" }), "«На главную»");
    await tall(page.locator(".lost").getByRole("link", { name: "К песням" }), "«К песням»");
  });

  test("сбой загрузки раздела: «Попробовать ещё раз» и «На главную» не ниже 44 px", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Модуль следующего раздела не загружается (обрыв сети): клиентский переход ведёт на страницу ошибки 500.
    await page.route("**/_app/immutable/nodes/**", (route) => route.abort());
    await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("link", { name: "Лидеры" }).click();
    await expect(page.getByRole("heading", { name: "Что-то пошло не так" })).toBeVisible();
    await expect(page).toHaveTitle(/Ошибка/);
    await tall(page.locator(".lost").getByRole("button", { name: "Попробовать ещё раз" }), "«Попробовать ещё раз»");
    await tall(page.locator(".lost").getByRole("link", { name: "На главную" }), "«На главную»");
  });
});

test("переход по ссылке внутри сайта на несуществующий адрес тоже ведёт на русскую страницу", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    const a = document.createElement("a");
    // /songs/* занят статическими аудиофайлами: Caddy возвращает там обычный 404.
    // Здесь проверяем несуществующую страницу приложения после его загрузки.
    a.href = "/missing/deeper";
    a.textContent = "битая ссылка";
    a.id = "broken";
    document.body.append(a);
  });
  await page.locator("#broken").click();
  await expect(page.getByRole("heading", { name: "Такой страницы нет" })).toBeVisible();
  await expect(page).toHaveTitle(/Страница не найдена/);
  await page.getByRole("link", { name: "На главную" }).click();
  await expect(page).toHaveURL(/\/$/);
});
