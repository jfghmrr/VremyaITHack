// Место под содержимое резервируется до загрузки: пока картинки и песня идут по медленной
// сети, страница не прыгает (CLS). Ответы намеренно задерживаются, проверяется геометрия
// до прихода данных и после.
import { expect, test, type Page, type Route } from "@playwright/test";

/** Задерживает ответы по шаблону до вызова release(). */
async function hold(page: Page, pattern: string) {
  const held: Route[] = [];
  let open = false;
  await page.route(pattern, (route) => (open ? route.continue() : void held.push(route)));
  return {
    count: () => held.length,
    release: async () => {
      open = true;
      for (const r of held.splice(0)) await r.continue();
    },
  };
}

for (const s of [{ w: 390, h: 844, touch: true }, { w: 1366, h: 768, touch: false }]) {
  test.describe(`${s.w}×${s.h}`, () => {
    test.use({ isMobile: s.touch, hasTouch: s.touch, viewport: { width: s.w, height: s.h } });

    test("главная: логотип и магнитофон занимают место до загрузки картинок", async ({ page }) => {
      const art = await hold(page, "**/art/**");
      await page.goto("/", { waitUntil: "domcontentloaded" });
      // Телефон (с 18.10.2026, макет владельца): вместо комнаты записка с котом, логотип — фон в
      // шапке (размер задан заранее). Проверяются кот и главное действие под ним.
      const logo = page.locator(s.touch ? ".hero-cat img" : ".logo img");
      const boombox = page.locator(s.touch ? ".phone-home .hero-go" : ".boombox img");
      await expect(logo).toBeAttached();
      await expect(boombox).toBeAttached();
      await expect.poll(() => art.count()).toBeGreaterThan(0);
      const box = async (l: typeof logo) => (await l.boundingBox())!;
      const [l0, b0] = [await box(logo), await box(boombox)];
      expect(l0.height, "логотип до загрузки").toBeGreaterThan(40);
      expect(b0.height, "магнитофон до загрузки").toBeGreaterThan(s.touch ? 50 : 80);
      await art.release();
      await expect.poll(() => logo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      if (!s.touch) await expect.poll(() => boombox.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      const [l1, b1] = [await box(logo), await box(boombox)];
      expect(Math.abs(l1.height - l0.height), "логотип после загрузки").toBeLessThan(1);
      expect(Math.abs(b1.height - b0.height), "магнитофон после загрузки").toBeLessThan(1);
      if (s.touch) expect(Math.abs(b1.y - b0.y), "главное действие не сдвинулось").toBeLessThan(1);
    });

    test("пение: подвал не прыгает, пока загружается песня", async ({ page }) => {
      const reference = await hold(page, "**/songs/cn-earth/reference.json");
      await page.goto("/sing/cn-earth", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Загружаем песню…")).toBeVisible();
      const footTop = () => page.locator("footer.foot").evaluate((f) => f.getBoundingClientRect().top + scrollY);
      const loading = await footTop();
      await reference.release();
      await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toBeVisible();
      const loaded = await footTop();
      // Подвал стоит там же, где окажется после загрузки, или оба положения за первым экраном.
      if (Math.abs(loaded - loading) > 1) expect(Math.min(loading, loaded), `подвал при загрузке ${loading}, после ${loaded}`).toBeGreaterThanOrEqual(s.h);
    });
  });
}
