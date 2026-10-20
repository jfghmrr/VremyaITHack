// Масштабирование сцен на разных мониторах и при масштабе ОС/браузера (правка владельца P4):
// у знакомого на внешнем мониторе картинки налезали друг на друга. Окна ниже — обычные
// мониторы, ноутбуки с масштабом 125 % и 150 % (окно браузера в CSS-пикселях) и короткие окна
// с панелями браузера. На каждом: предметы сцены не перекрывают друг друга, шкафчики на главной
// не превращаются в столбы, карточки песен не обрезаны и не закрывают строку каталога.
// Снимки: test-results/scaling/<ширина>x<высота>[@dpr]-<экран>.png.
import { expect, test, type Page } from "@playwright/test";

type Size = { w: number; h: number; dpr?: number };
const sizes: Size[] = [
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
  { w: 3440, h: 1440 },
  { w: 1366, h: 768 },
  { w: 1280, h: 720 },
  { w: 1536, h: 864 },
  { w: 1536, h: 864, dpr: 1.25 }, // 1920×1080 при масштабе 125 %
  { w: 1280, h: 720, dpr: 1.5 }, // 1920×1080 при масштабе 150 %
  { w: 1920, h: 950 }, // 1920×1080 с панелями браузера
  { w: 1536, h: 730 }, // 125 % с панелями браузера
  { w: 1280, h: 600 }, // 150 % с панелями браузера
];

type Box = { x: number; y: number; w: number; h: number };
async function box(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).display === "none") return null;
    return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
  }, selector);
}
/** Площадь пересечения как доля меньшего прямоугольника. */
const overlap = (a: Box, b: Box) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0;
};

/** Пары предметов сцены, которые не должны перекрываться (допуск — доля меньшего). */
const pages: { route: string; name: string; pairs: [string, string, number][] }[] = [
  {
    route: "/",
    name: "home",
    pairs: [
      [".home .logo", ".home .boombox", 0],
      [".home .tagline", ".home .boombox", 0.02],
      // Слоган заходит на низ логотипа по мокапу (коллаж); на коротком окне он закрывал магнитофон.
      [".home .logo", ".home .tagline", 0.4],
      [".home .home-cat", ".home .music-corner", 0],
      [".home .music-corner", ".home .lockers", 0],
      [".home .tagline", ".home .lockers", 0],
      [".home .tagline", ".home .home-cat", 0.02],
    ],
  },
  {
    route: "/leaders",
    name: "leaders",
    pairs: [
      [".leaders .book", ".leaders .first-photo", 0],
      [".leaders .book", ".leaders .second-photo", 0],
      [".leaders .book", ".leaders .stage-pass", 0],
      [".leaders .first-photo", ".leaders .stage-pass", 0],
      [".leaders .second-photo", ".leaders .stage-pass", 0],
      [".leaders .first-photo", ".leaders .second-photo", 0.15],
    ],
  },
  {
    route: "/songs",
    name: "songs",
    pairs: [
      [".pick .catalog-bar", ".pick .song.checked", 0],
      [".pick .toolbar", ".pick .catalog-bar", 0],
      [".pick .carousel", ".pick .deck", 0],
    ],
  },
  {
    route: "/result",
    name: "result-empty",
    pairs: [
      [".empty .empty-note", ".empty .sleeper", 0],
      [".empty .empty-note", ".empty .side-note", 0],
    ],
  },
];

for (const s of sizes) {
  const label = `${s.w}×${s.h}${s.dpr ? `@${s.dpr}` : ""}`;
  test.describe(label, () => {
    test.use({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.dpr ?? 1 });

    test(`${label}: сцены без наложений`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const p of pages) {
        await page.goto(p.route);
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        for (const [a, b, limit] of p.pairs) {
          const [ba, bb] = [await box(page, a), await box(page, b)];
          expect.soft(ba, `${label} ${p.route}: ${a} отрисован`).not.toBeNull();
          expect.soft(bb, `${label} ${p.route}: ${b} отрисован`).not.toBeNull();
          if (ba && bb) expect.soft(overlap(ba, bb), `${label} ${p.route}: ${a} × ${b}`).toBeLessThanOrEqual(limit);
        }
        // Горизонтальной прокрутки нет; главная и лидеры помещаются в окно без вертикальной.
        const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
        expect.soft(doc.w, `${label} ${p.route}: горизонтальная прокрутка`).toBeLessThanOrEqual(s.w);
        if (p.name === "home" || p.name === "leaders") expect.soft(doc.h, `${label} ${p.route}: вертикальная прокрутка`).toBeLessThanOrEqual(s.h);
        if (p.name === "home") {
          for (const locker of await page.locator(".locker").all()) {
            const b = (await locker.boundingBox())!;
            expect.soft(b.height / b.width, `${label}: шкафчик не столб (высота/ширина)`).toBeLessThanOrEqual(3.1);
          }
        }
        if (p.name === "songs") {
          // Выбранная карточка целиком видна в ленте (не обрезана снизу или сверху).
          const card = (await box(page, ".pick .song.checked"))!;
          const strip = (await box(page, ".pick .songs"))!;
          expect.soft(card.y, `${label}: карточка обрезана сверху`).toBeGreaterThanOrEqual(strip.y - 1);
          expect.soft(card.y + card.h, `${label}: карточка обрезана снизу`).toBeLessThanOrEqual(strip.y + strip.h + 1);
          // Ссылка «Мои треки» / «Свой трек» не закрыта лентой: в её центре — она сама.
          const link = page.getByRole("link", { name: /Мои треки|Свой трек/ });
          if (await link.count()) {
            const hit = await link.evaluate((el) => {
              const r = el.getBoundingClientRect();
              const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return !!top && (top === el || el.contains(top));
            });
            expect.soft(hit, `${label}: ссылка на свои треки перекрыта`).toBe(true);
          }
        }
        await page.screenshot({ path: `test-results/scaling/${s.w}x${s.h}${s.dpr ? `@${s.dpr}` : ""}-${p.name}.png` });
      }
    });
  });
}
