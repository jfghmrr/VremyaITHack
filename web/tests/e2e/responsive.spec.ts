// Матрица устройств: телефоны (портрет и ландшафт), планшеты, ноутбуки, большие и
// сверхширокие мониторы. На каждом размере: нет горизонтальной прокрутки и обрезанных
// краёв, элементы управления не налезают друг на друга, вкладки навигации не обрезаны,
// на сенсорных размерах цели нажатия не меньше 44 px, на сцене пения «Стоп» в окне.
// Проекты chromium и webkit; синтетический микрофон (fake-mic.ts) подменяет getUserMedia
// в странице, поэтому пение проверяется в обоих движках.
// Снимки для просмотра глазами: test-results/matrix/<движок>-<ширина>x<высота>-<экран>.png.
import { expect, test, type Browser, type Cookie, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";
import { accepted, password } from "./helpers";

type Group = "phone" | "tablet" | "desktop";
type Size = { w: number; h: number };
const groups: Record<Group, Size[]> = {
  phone: [
    { w: 360, h: 740 },
    { w: 390, h: 844 },
    { w: 430, h: 932 },
    { w: 844, h: 390 },
    { w: 932, h: 430 },
  ],
  tablet: [
    { w: 768, h: 1024 },
    { w: 1024, h: 768 },
    { w: 820, h: 1180 },
    { w: 1180, h: 820 },
  ],
  desktop: [
    { w: 1280, h: 720 },
    { w: 1366, h: 768 },
    { w: 1920, h: 1080 },
    { w: 2560, h: 1440 },
    { w: 3440, h: 1440 },
  ],
};
const guestRoutes = ["/", "/songs", "/account", "/progress", "/leaders", "/friends", "/duels", "/legal/privacy", "/no-such-page"];
// Те же разделы в кабинете: настройки, адресная книга, тетрадь, таблица.
const memberRoutes = ["/account", "/friends", "/progress", "/leaders", "/duels"];

const slug = (route: string) => route.replace(/^\//, "").replace(/\//g, "-") || "home";
const shotPath = (browserName: string, s: Size, name: string) => `test-results/matrix/${browserName}-${s.w}x${s.h}-${name}.png`;

// Один кабинет на прогон: лимит регистраций на адрес не расходуется на каждый размер.
const userFile = "test-results/.matrix-user.json";
async function memberCookies(browser: Browser): Promise<Cookie[]> {
  if (existsSync(userFile)) return JSON.parse(readFileSync(userFile, "utf8"));
  // Без разрешений микрофона и буфера обмена: так же работает в WebKit.
  const context = await browser.newContext({ storageState: accepted() });
  const page = await context.newPage();
  await page.goto("/");
  const status = await page.evaluate(async (password) => {
    const email = `matrix-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-perepev-request": "1" },
      body: JSON.stringify({ email, name: "Музыкальный кот Матвей", password, consent: true, ageGroup: "14plus" }),
    });
    return res.status;
  }, password);
  expect(status, "регистрация кабинета для матрицы").toBe(201);
  const cookies = (await context.storageState()).cookies;
  await context.close();
  writeFileSync(userFile, JSON.stringify(cookies));
  return cookies;
}

type Box = { left: number; top: number; right: number; bottom: number };
type Audit = {
  innerWidth: number;
  scrollWidth: number;
  outside: string[];
  overlaps: string[];
  nav: string[];
  small: string[];
};

/** Геометрия страницы в браузере: только видимые и доступные для нажатия элементы. */
async function audit(page: Page, touch: boolean): Promise<Audit> {
  return page.evaluate((touch) => {
    const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
    const name = (el: Element) => {
      const label = el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || el.textContent?.replace(/\s+/g, " ").trim() || "";
      const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).filter((c) => !c.startsWith("s-")).slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls}«${label.slice(0, 28)}»`;
    };
    const fmt = (b: Box) => `[${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.right - b.left)}×${Math.round(b.bottom - b.top)}]`;
    // Видимая часть элемента: пересечение с областями прокрутки и обрезки предков
    // (кроме html/body: страница прокручивается, а не обрезает).
    const visible = (el: Element): Box | null => {
      if (el.closest("[inert]")) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      let { left, top, right, bottom } = r;
      for (let p: Element | null = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;
        if (p === el) continue;
        const c = p.getBoundingClientRect();
        if (cs.overflowX !== "visible") {
          left = Math.max(left, c.left);
          right = Math.min(right, c.right);
        }
        if (cs.overflowY !== "visible") {
          top = Math.max(top, c.top);
          bottom = Math.min(bottom, c.bottom);
        }
      }
      return right - left >= 1 && bottom - top >= 1 ? { left, top, right, bottom } : null;
    };
    const controls = [...document.querySelectorAll(INTERACTIVE)].map((el) => ({ el, box: visible(el) })).filter((c): c is { el: Element; box: Box } => c.box !== null);

    const W = innerWidth;
    const outside: string[] = [];
    const texts = [...document.querySelectorAll("h1, h2, h3, p, li, label, dt, dd, strong")].filter((el) => !el.closest('.deco, [aria-hidden="true"]'));
    for (const el of [...controls.map((c) => c.el), ...texts]) {
      const b = visible(el);
      if (b && (b.left < -1 || b.right > W + 1)) outside.push(`${name(el)} ${fmt(b)}`);
    }

    const overlaps: string[] = [];
    // Телефон (с 18.10.2026): нижнее меню закреплено, панель «Петь» на песнях прилипает над ним —
    // страница прокручивается под ними по замыслу. Пара «панель — элемент страницы» не в счёт,
    // только если элемент выходит из-под панели: строки списка песен под панелью «Петь»; под
    // нижним меню — элемент, который прокручивается вместе со страницей и в самом её конце
    // оказывается выше меню. Закреплённый элемент под меню (как «Сохранить» в редакторе текста)
    // по-прежнему ошибка.
    const floatingBar = (el: Element) => {
      const bar = el.closest("nav.tabbar, .pick .deck");
      return bar && ["fixed", "sticky"].includes(getComputedStyle(bar).position) ? bar : null;
    };
    const pinned = (el: Element) => {
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) if (["fixed", "sticky"].includes(getComputedStyle(p).position)) return true;
      return false;
    };
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    const clearsUnder = (bar: Element, el: Element) => {
      if (bar.matches(".deck")) return !!el.closest(".songs");
      if (pinned(el)) return false;
      return el.getBoundingClientRect().bottom + scrollY - maxScroll <= bar.getBoundingClientRect().top + 0.5;
    };
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const [fa, fb] = [floatingBar(a.el), floatingBar(b.el)];
        if (!fa !== !fb && clearsUnder((fa ?? fb)!, fa ? b.el : a.el)) continue;
        const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (w > 0 && h > 0 && w * h > 4) overlaps.push(`${name(a.el)} ${fmt(a.box)} × ${name(b.el)} ${fmt(b.box)}`);
      }

    const nav: string[] = [];
    const main = document.querySelector('nav[aria-label="Основная навигация"]');
    if (main) {
      const n = main.getBoundingClientRect();
      if (n.left < -1 || n.right > W + 1) nav.push(`навигация выходит за окно ${fmt(n)}`);
      for (const a of main.querySelectorAll("a")) {
        const r = a.getBoundingClientRect();
        // Ярлыки слегка наклонены (±1.2°): допуск по вертикали на наклон, по горизонтали 2 px.
        if (r.left < n.left - 2 || r.right > n.right + 2 || r.top < n.top - 4 || r.bottom > n.bottom + 4) nav.push(`${name(a)} вне контейнера ${fmt(r)} / ${fmt(n)}`);
        if (a.scrollWidth > a.clientWidth + 1) nav.push(`${name(a)}: текст обрезан`);
      }
    }

    // Сенсорные размеры: цели нажатия не меньше 44 px (ссылки внутри текста не в счёт).
    const small: string[] = [];
    if (touch)
      for (const { el, box } of controls) {
        // Ссылка внутри предложения (WCAG 2.5.8: исключение для строчных целей).
        if (el.matches("a:not(.btn)") && getComputedStyle(el).display === "inline") continue;
        if (el.matches('input[type="checkbox"], input[type="radio"]')) continue;
        if (el.matches(".visually-hidden, .visually-hidden *")) continue;
        const r = el.getBoundingClientRect();
        if (box.bottom - box.top < r.height - 1 || box.right - box.left < r.width - 1) continue; // частично прокручено в ленте
        if (r.height < 44 - 0.5 || r.width < 44 - 0.5) small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    return { innerWidth: W, scrollWidth: document.documentElement.scrollWidth, outside, overlaps, nav, small };
  }, touch);
}

async function check(page: Page, s: Size, touch: boolean, label: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const a = await audit(page, touch);
  const where = `${s.w}×${s.h} ${label}`;
  expect.soft(a.innerWidth, `${where}: ширина окна (мобильный браузер не должен уменьшать масштаб)`).toBe(s.w);
  expect.soft(a.scrollWidth, `${where}: горизонтальная прокрутка`).toBeLessThanOrEqual(a.innerWidth);
  expect.soft(a.outside, `${where}: элементы за краем окна`).toEqual([]);
  expect.soft(a.overlaps, `${where}: элементы управления перекрываются`).toEqual([]);
  expect.soft(a.nav, `${where}: вкладки навигации`).toEqual([]);
  expect.soft(a.small, `${where}: цели нажатия меньше 44 px`).toEqual([]);
}

/** Элемент целиком в окне без прокрутки. */
async function inViewport(page: Page, locator: ReturnType<Page["locator"]>, s: Size, what: string) {
  const box = await locator.boundingBox();
  expect.soft(box, `${s.w}×${s.h}: ${what} не отрисован`).not.toBeNull();
  if (!box) return;
  const scroll = await page.evaluate(() => scrollY);
  expect.soft(
    { top: box.y + scroll >= 0, left: box.x >= 0, bottom: box.y + scroll + box.height <= s.h + 0.5, right: box.x + box.width <= s.w + 0.5 },
    `${s.w}×${s.h}: ${what} ${JSON.stringify(box)} должен быть в окне без прокрутки`,
  ).toEqual({ top: true, left: true, bottom: true, right: true });
}

async function closeToasts(page: Page) {
  const close = page.getByRole("button", { name: "Закрыть достижение" });
  for (let i = 0; i < 8 && (await close.count()); i++) await close.first().click();
}

for (const [group, sizes] of Object.entries(groups) as [Group, Size[]][]) {
  const touch = group !== "desktop";
  test.describe(`матрица: ${group}`, () => {
    test.use({ isMobile: group === "phone", hasTouch: touch, viewport: { width: sizes[0].w, height: sizes[0].h } });

    for (const s of sizes) {
      test(`${s.w}×${s.h}: страницы без микрофона`, async ({ page, context, browser, browserName }) => {
        test.setTimeout(180_000);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: s.w, height: s.h });
        for (const route of guestRoutes) {
          await page.goto(route);
          await page.waitForLoadState("networkidle");
          await check(page, s, touch, route);
          await page.screenshot({ path: shotPath(browserName, s, slug(route)), fullPage: true });
        }
        await context.addCookies(await memberCookies(browser));
        for (const route of memberRoutes) {
          await page.goto(route);
          await page.waitForLoadState("networkidle");
          await check(page, s, touch, `${route} (кабинет)`);
          await page.screenshot({ path: shotPath(browserName, s, `${slug(route)}-member`), fullPage: true });
        }
      });
    }

    test("микрофон, сцена пения и результат", async ({ page, context, browserName }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      // Намеренная ошибка на 5–6 с: в разборе будет момент для тренировки.
      await fakeMic(context, "cn-earth", { shift: -3, errors: [[500, 610, 2]] });
      await page.goto("/sing/cn-earth");
      await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toBeVisible();
      await page.getByRole("button", { name: "Включить микрофон" }).click();
      const go = page.getByRole("button", { name: "Начать пение" });
      await expect(go).toBeEnabled();
      for (const s of sizes) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await page.evaluate(() => scrollTo(0, 0));
        await check(page, s, touch, "/sing проверка микрофона");
        await inViewport(page, go, s, "кнопка «Начать пение»");
        await page.screenshot({ path: shotPath(browserName, s, "sing-mic"), fullPage: true });
      }
      await page.setViewportSize({ width: sizes[0].w, height: sizes[0].h });
      await go.click();
      const stageView = page.getByLabel("Пение", { exact: true });
      await expect(stageView).toBeVisible();
      await page.waitForTimeout(3500); // отсчёт закончился, идёт песня
      for (const s of sizes) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await page.waitForTimeout(150);
        await check(page, s, touch, "/sing сцена");
        await inViewport(page, page.getByRole("button", { name: "Выйти", exact: true }), s, "кнопка «Стоп» на сцене");
        await inViewport(page, page.getByRole("button", { name: "Пауза", exact: true }), s, "кнопка паузы на сцене");
        await inViewport(page, page.locator(".stage .screen"), s, "график высоты голоса");
        await expect.soft(page.locator(".stage .lines li.now").first(), `${s.w}×${s.h}: текущая строка песни`).toBeInViewport();
        // Три круглые клавиши не сжимаются, время «0:03 / 0:13» в одну строку.
        const player = await page.evaluate(() => {
          const time = document.querySelector(".stage .time")!;
          const range = document.createRange();
          range.selectNodeContents(time);
          return {
            timeLines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
            keys: [...document.querySelectorAll(".stage .round")].map((k) => [Math.round(k.getBoundingClientRect().width), Math.round(k.getBoundingClientRect().height)]),
          };
        });
        expect.soft(player.timeLines, `${s.w}×${s.h}: время на сцене в одну строку`).toBe(1);
        expect.soft(player.keys, `${s.w}×${s.h}: клавиши плеера 52×52`).toEqual([[52, 52], [52, 52], [52, 52]]);
        await page.screenshot({ path: shotPath(browserName, s, "sing-stage") });
      }
      await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
      await expect(page.getByLabel(/из 100/)).toBeVisible();
      await page.waitForTimeout(1000);
      await closeToasts(page);
      for (const s of sizes) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await page.evaluate(() => scrollTo(0, 0));
        await check(page, s, touch, "/result");
        await page.screenshot({ path: shotPath(browserName, s, "result"), fullPage: true });
      }
      await page.getByRole("button", { name: "Разбор и ошибки" }).click();
      for (const s of sizes) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await page.evaluate(() => scrollTo(0, 0));
        await check(page, s, touch, "/result разбор");
        await page.screenshot({ path: shotPath(browserName, s, "result-analysis"), fullPage: true });
      }
      await page.getByRole("button", { name: "Потренировать" }).first().click();
      await expect(page.getByText("Тренировка без оценки")).toBeVisible();
      for (const s of sizes) {
        await page.setViewportSize({ width: s.w, height: s.h });
        await page.evaluate(() => scrollTo(0, 0));
        await check(page, s, touch, "/practice");
        await page.screenshot({ path: shotPath(browserName, s, "practice"), fullPage: true });
      }
    });
  });
}

/** Средняя яркость (0…1) участка окна: PNG декодируется в пустой странице через canvas. */
async function brightness(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = await page.screenshot({ clip });
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      return sum / (d.length / 4);
    }, png.toString("base64"));
  } finally {
    await blank.close();
  }
}

/** Середина элемента (без наклонённых краёв) в координатах окна. */
async function middle(locator: ReturnType<Page["locator"]>) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  expect(b, "элемент не отрисован").not.toBeNull();
  return { x: b!.x + b!.width * 0.2, y: b!.y + b!.height * 0.25, width: b!.width * 0.6, height: b!.height * 0.5 };
}

// WebKit рисовал зеркальную заднюю пластину дверцы поверх лицевой: на главной были
// пустые цветные плиты без «Друзья» и «Мои песни». Ярлык и открытый шкафчик — бумага
// (светлые), металл дверцы тёмный, поэтому проверка по яркости снимка.
// С 18.10.2026 на телефоне в портрете вместо комнаты со шкафчиками — записка и карточки разделов
// (макет владельца, tabbar.spec.ts и redesign.spec.ts); шкафчики проверяются на ноутбуке и на
// ландшафте телефона, где комната осталась.
for (const s of [{ w: 844, h: 390 }, { w: 1366, h: 768 }]) {
  const touch = s.w < 900;
  test.describe(`шкафчики на главной ${s.w}×${s.h}`, () => {
    test.use({ isMobile: touch, hasTouch: touch, viewport: { width: s.w, height: s.h } });

    test("дверца с надписью видна, открытый шкафчик показывает содержимое", async ({ page, browserName }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const lockers = page.locator(".locker");
      await expect(lockers).toHaveCount(2);
      for (const [i, label] of ["Друзья", "Мои песни"].entries()) {
        const locker = lockers.nth(i);
        await expect(locker.locator(".tag")).toHaveText(label);
        const closed = await brightness(page, await middle(locker.locator(".tag")));
        expect(closed, `${browserName} ${s.w}×${s.h}: ярлык «${label}» на закрытой дверце`).toBeGreaterThan(0.45);
        if (i === 1) await page.screenshot({ path: shotPath(browserName, s, "lockers-closed") });
        await locker.locator("a.door").focus();
        await expect(locker).toHaveClass(/\bopen\b/);
        await expect(locker.locator(".inside")).toHaveCSS("opacity", "1");
        const inside = await brightness(page, await middle(locker.locator(".inside")));
        expect(inside, `${browserName} ${s.w}×${s.h}: открытый шкафчик «${label}»`).toBeGreaterThan(0.45);
        await page.screenshot({ path: shotPath(browserName, s, `lockers-open-${i + 1}`) });
        await locker.locator("a.door").blur();
        await expect(locker).not.toHaveClass(/\bopen\b/);
      }
    });
  });
}

// Первый визит с пустым хранилищем: показаны уведомление о cookie и согласие на запись голоса.
// Уведомление не закрывает главное действие экрана (на телефоне в ландшафте раньше закрывало),
// учитывает вырезы экрана и не даёт горизонтальной прокрутки.
for (const s of [{ w: 390, h: 844 }, { w: 844, h: 390 }]) {
  test.describe(`первый визит ${s.w}×${s.h}`, () => {
    test.use({ isMobile: true, hasTouch: true, viewport: { width: s.w, height: s.h }, storageState: { cookies: [], origins: [] } });

    test("уведомление о cookie не закрывает главное действие", async ({ page, browserName }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const screens = [
        { route: "/", action: page.getByRole("link", { name: /Начать петь/ }) },
        { route: "/sing/cn-earth", action: page.getByRole("button", { name: "Согласен, включить микрофон" }) },
      ];
      for (const { route, action } of screens) {
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        const banner = page.getByRole("region", { name: "Уведомление о cookie" });
        await expect(banner).toBeVisible();
        await expect(action).toBeVisible();
        await check(page, s, true, `${route} первый визит`);
        await page.screenshot({ path: shotPath(browserName, s, `${slug(route)}-first-visit`), fullPage: true });
        await action.scrollIntoViewIfNeeded();
        const [a, b] = [await action.boundingBox(), await banner.boundingBox()];
        expect(a && b, `${route}: элементы отрисованы`).toBeTruthy();
        const overlap = Math.min(a!.x + a!.width, b!.x + b!.width) > Math.max(a!.x, b!.x) && Math.min(a!.y + a!.height, b!.y + b!.height) > Math.max(a!.y, b!.y);
        expect.soft(overlap, `${s.w}×${s.h} ${route}: уведомление ${JSON.stringify(b)} закрывает главное действие ${JSON.stringify(a)}`).toBe(false);
        const hit = await action.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && (el === top || el.contains(top));
        });
        expect.soft(hit, `${s.w}×${s.h} ${route}: главное действие доступно для нажатия`).toBe(true);
      }
    });
  });
}

// «К содержимому» (QA L27): спрятана, пока нет фокуса (не цель нажатия и не видна), а в фокусе
// видна целиком и на сенсорном экране не ниже 44 px; переход ставит фокус в основное содержимое.
test.describe("ссылка «К содержимому» 390×844", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test("скрыта без фокуса, в фокусе видна и не ниже 44 px", async ({ page }) => {
    await page.goto("/songs");
    await page.waitForLoadState("networkidle");
    const skip = page.getByRole("link", { name: "К содержимому" });
    await expect(skip).toHaveCSS("opacity", "0");
    await skip.focus();
    await expect(skip).toHaveCSS("opacity", "1");
    await expect(skip).toBeInViewport({ ratio: 1 });
    const box = await skip.boundingBox();
    expect(box!.height, "высота ссылки в фокусе").toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await expect(skip).toHaveCSS("opacity", "0");
  });
});

test.describe("поворот телефона", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test("rotation keeps singing", async ({ page, context, browserName }) => {
    test.setTimeout(90_000);
    // Учёт AudioContext и Screen Wake Lock: поворот не должен пересоздавать звук.
    await context.addInitScript(() => {
      const w = window as unknown as { __audio: { ctx: AudioContext; interactive: boolean }[]; __wake: { requests: number; held: number } };
      w.__audio = [];
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(options?: AudioContextOptions) {
          super(options);
          w.__audio.push({ ctx: this, interactive: options?.latencyHint === "interactive" });
        }
      };
      w.__wake = { requests: 0, held: 0 };
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async () => {
            w.__wake.requests++;
            w.__wake.held++;
            const sentinel = Object.assign(new EventTarget(), { type: "screen", released: false, release: async () => {
              if (!sentinel.released) { sentinel.released = true; w.__wake.held--; }
            } });
            return sentinel;
          },
        },
      });
    });
    await fakeMic(context, "cn-earth", { shift: -3 });
    const audioState = () => page.evaluate(() => {
      const w = window as unknown as { __audio: { ctx: AudioContext; interactive: boolean }[] };
      return { count: w.__audio.length, capture: w.__audio.filter((a) => a.interactive).map((a) => a.ctx.state) };
    });
    const wake = () => page.evaluate(() => (window as unknown as { __wake: { requests: number; held: number } }).__wake);

    await page.goto("/sing/cn-earth");
    await page.getByRole("button", { name: "Включить микрофон" }).click();
    await page.getByRole("button", { name: "Начать пение" }).click();
    await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
    await page.waitForTimeout(6500); // отсчёт и треть песни
    const before = await audioState();
    expect(before.capture).toEqual(["running"]);
    expect(await wake()).toEqual({ requests: 1, held: 1 });
    await page.screenshot({ path: shotPath(browserName, { w: 390, h: 844 }, "rotation-portrait") });

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(800);
    const after = await audioState();
    expect(after.count, "поворот не создаёт новый AudioContext").toBe(before.count);
    expect(after.capture).toEqual(["running"]);
    await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
    await inViewport(page, page.getByRole("button", { name: "Выйти", exact: true }), { w: 844, h: 390 }, "кнопка «Стоп» после поворота");
    await expect(page.locator(".stage .lines li.now").first()).toBeInViewport();
    await page.screenshot({ path: shotPath(browserName, { w: 844, h: 390 }, "rotation-landscape") });

    await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
    const label = await page.getByLabel(/из 100/).getAttribute("aria-label");
    expect(Number(label!.split(" ")[0]), "запись продолжалась после поворота").toBeGreaterThan(75);
    expect((await wake()).held, "экран отпущен после пения").toBe(0);
  });
});
