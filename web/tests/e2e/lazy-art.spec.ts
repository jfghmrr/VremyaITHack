// Декор, скрытый на телефоне, не скачивается (loading="lazy"); на ноутбуке он на месте.
// Картинки над сгибом грузятся сразу: логотип, кресло с котом, магнитофон, звезда, фон комнаты,
// а в раскладке wide — кот проверки микрофона.
import { expect, test, type Page } from "@playwright/test";

const hiddenOnPhones: [string, string][] = [
  ["/songs", "mascots/cat-sing-s01"],
  ["/leaders", "mascots/cat-guitar-s03"],
  ["/sing/cn-earth", "mascots/cat-sing-s01"],
];

function artRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/art/")) urls.push(new URL(r.url()).pathname); });
  return urls;
}

const eagerOnHome = [".logo img", ".chair img", ".boombox img", ".wall img", ".home-cat .cat img", ".star-switch img"];

test.describe("телефон 390×844", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const [route, art] of hiddenOnPhones)
    test(`${route}: скрытый декор ${art} не скачивается`, async ({ page }) => {
      const urls = artRequests(page);
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await page.evaluate(async () => { scrollTo(0, document.documentElement.scrollHeight); await new Promise((r) => setTimeout(r, 500)); });
      await page.waitForLoadState("networkidle");
      expect(urls.some((u) => u.includes("/art/backgrounds/")), "фон комнаты").toBe(true);
      expect(urls.filter((u) => u.includes(art))).toEqual([]);
    });

  // С 18.10.2026 комната на телефоне в портрете скрыта (вместо неё записка и карточки): её кресло
  // и магнитофон не скачиваются (<picture> с пустым источником для телефона); кот — тот же файл,
  // что в записке.
  test("главная: картинки скрытой комнаты не скачиваются", async ({ page }) => {
    const urls = artRequests(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => { scrollTo(0, document.documentElement.scrollHeight); await new Promise((r) => setTimeout(r, 500)); });
    await page.waitForLoadState("networkidle");
    expect(urls.some((u) => u.includes("mascots/cat-listen-s01")), "кот записки").toBe(true);
    expect(urls.filter((u) => u.includes("furniture/armchair") || u.includes("devices/boombox-s02"))).toEqual([]);
  });

  test("главная: картинки первого экрана без отложенной загрузки", async ({ page }) => {
    await page.goto("/");
    for (const sel of eagerOnHome) await expect(page.locator(sel), sel).not.toHaveAttribute("loading", "lazy");
    await expect.poll(() => page.locator(".home-cat .cat img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  });
});

test.describe("ноутбук 1366×768", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  for (const [route, art] of hiddenOnPhones)
    test(`${route}: декор ${art} на месте`, async ({ page }) => {
      await page.goto(route);
      const img = page.locator(`img[src*="${art}"]`).first();
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    });

  test("главная и проверка микрофона: картинки над сгибом без отложенной загрузки", async ({ page }) => {
    await page.goto("/");
    for (const sel of eagerOnHome) await expect(page.locator(sel), sel).not.toHaveAttribute("loading", "lazy");
    await page.goto("/sing/cn-earth");
    await expect(page.locator(".check-cat img")).toBeVisible();
    await expect(page.locator(".check-cat img")).not.toHaveAttribute("loading", "lazy");
  });
});
