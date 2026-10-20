// Композиция страниц на широких мониторах (замечание владельца 17.10.2026: на ~2000 px содержимое
// «Кабинета», «Своих людей» и «Дуэлей» прижималось к краям с пустотой посередине, а одна колонка
// пустовала до низа). На каждом размере: группа содержимого по центру окна, заголовок над её левым
// краем, колонки заполнены сопоставимо, нет горизонтальной прокрутки; «Свои люди» на высоком окне —
// по центру и по вертикали; пустые состояния (друзья, лидеры) заполнены.
// Пороги высоты окна — «wide-*» в web/src/lib/styles/tokens.css.
// Снимки: test-results/composition/<движок>-<ширина>x<высота>-<страница>.png.
import { expect, test, type Browser, type Cookie, type Page } from "@playwright/test";
import { accepted, password } from "./helpers";

type Box = { left: number; right: number; top: number; bottom: number };
type Check = {
  route: string;
  name: string;
  /** Корень композиции на странице. */
  root: string;
  /** Заголовок страницы, который обязан быть над левым краем группы. */
  title: string;
  /** Колонки, которые должны быть заполнены сопоставимо (у каждой — список частей). */
  columns?: string[][];
  /** Какую долю высоты самой длинной колонки должна занимать самая короткая. */
  fill?: number;
  /** Колонки стоят рядом: просвет между ними не шире 10 % окна (нет дыры посередине). */
  sideBySide?: boolean;
  /** Ширина группы не больше стольких rem (не растянута от края до края контейнера). */
  maxRem?: number;
  /** Элементы, которые лежат внутри группы и вместе занимают почти всю её ширину. */
  spread?: string;
  /** Корень — сетка во всю ширину контейнера (документы): заголовок сравнивается с левым краем
   *  видимого содержимого, а не корня. */
  wideRoot?: boolean;
};

const checks: Check[] = [
  { route: "/account", name: "account", root: ".guest", title: ".guest .strip", columns: [[".guest .head", ".guest .perks", ".guest .fine"], [".guest .door"]], fill: 0.55, sideBySide: true, maxRem: 72 },
  { route: "/friends", name: "friends", root: ".friends-page", title: ".friends-page .strip", maxRem: 74, spread: ".steps > .step" },
  { route: "/duels", name: "duels", root: ".duels", title: ".duels .strip", columns: [[".duels > header", ".duels .guide"], [".duels .body"]], fill: 0.6, sideBySide: true },
  // У документов нет ярлыка: заголовок — колонка закладок слева от листа.
  { route: "/legal/terms", name: "legal", root: ".legal", title: ".legal nav", maxRem: 70, wideRoot: true },
  { route: "/practice", name: "practice", root: ".empty-page", title: ".empty-page .strip", maxRem: 64 },
];
const sizes = [
  { w: 1920, h: 1080 },
  { w: 2000, h: 1200 },
  { w: 2560, h: 1440 },
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },
];

/** Объединение прямоугольников видимых элементов (кроме скрытых и нулевых). С `inside` — только
 *  потомков: сам корень-сетка во всю ширину контейнера не делает содержимое «центрованным». */
async function union(page: Page, selectors: string[], inside = false): Promise<Box | null> {
  return page.evaluate(
    ({ selectors, inside }) => {
      const boxes: DOMRect[] = [];
      for (const sel of selectors)
        for (const root of document.querySelectorAll(sel))
          for (const el of inside ? root.querySelectorAll("*") : [root, ...root.querySelectorAll("*")]) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[hidden]")) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 1 && r.height > 1) boxes.push(r);
          }
      if (!boxes.length) return null;
      return {
        left: Math.min(...boxes.map((b) => b.left)),
        right: Math.max(...boxes.map((b) => b.right)),
        top: Math.min(...boxes.map((b) => b.top + scrollY)),
        bottom: Math.max(...boxes.map((b) => b.bottom + scrollY)),
      };
    },
    { selectors, inside },
  );
}

/** Вёрстка устоялась: шрифты загружены, рамка корня и высота документа одинаковы три кадра подряд
 *  (вместо фиксированной паузы). */
async function settled(page: Page, root: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    (root) => {
      const w = window as unknown as { __shape?: string; __same?: number };
      const r = document.querySelector(root)?.getBoundingClientRect();
      const shape = r ? `${r.left},${r.top},${r.width},${r.height},${document.documentElement.scrollHeight}` : "";
      w.__same = shape && shape === w.__shape ? (w.__same ?? 0) + 1 : 0;
      w.__shape = shape;
      return w.__same >= 2;
    },
    root,
    { polling: "raf" },
  );
}

/** Пустое место над группой (от шапки) и под ней (до подвала). */
async function verticalGaps(page: Page, root: string) {
  const box = (await union(page, [root], true))!;
  const { head, foot } = await page.evaluate(() => ({
    head: document.querySelector("header.top")!.getBoundingClientRect().bottom + scrollY,
    foot: document.querySelector(".foot")!.getBoundingClientRect().top + scrollY,
  }));
  return { above: box.top - head, below: foot - box.bottom };
}

async function checkPage(page: Page, c: Check, s: { w: number; h: number }, browserName: string) {
  await page.goto(c.route);
  await page.waitForLoadState("networkidle");
  await settled(page, c.root);
  const where = `${s.w}×${s.h} ${c.route}`;
  const box = await union(page, [c.root], true);
  expect(box, `${where}: ${c.root} отрисован`).not.toBeNull();
  if (!box) return;
  // Центр группы совпадает с центром окна (допуск 4 % ширины): нет «формы у правого края».
  const centre = (box.left + box.right) / 2;
  expect.soft(Math.abs(centre - s.w / 2), `${where}: центр содержимого ${Math.round(centre)} при окне ${s.w}`).toBeLessThanOrEqual(s.w * 0.04);
  // Заголовок есть и стоит над левым краем содержимого корня (без его отступа). Наклейки-номера
  // шагов «Своих людей» нарочно выступают за этот край, поэтому сравниваем не с объединением.
  await expect(page.locator(c.title).first(), `${where}: заголовок ${c.title}`).toBeVisible();
  const title = (await page.locator(c.title).first().boundingBox())!;
  const inner = await page.locator(c.root).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) };
  });
  expect.soft(Math.abs(title.x - (c.wideRoot ? box.left : inner.left)), `${where}: заголовок у левого края содержимого`).toBeLessThanOrEqual(24);
  if (c.columns && c.fill) {
    const cols = await Promise.all(c.columns.map((sels) => union(page, sels)));
    const heights = cols.map((b) => (b ? b.bottom - box.top : 0));
    const longest = Math.max(...heights);
    for (const [i, h] of heights.entries())
      expect.soft(h / longest, `${where}: колонка ${i + 1} заполнена (${Math.round(h)} из ${Math.round(longest)} px)`).toBeGreaterThanOrEqual(c.fill);
  }
  if (c.spread) {
    // Шаги внутри группы и вместе занимают её ширину, а не жмутся к одному краю.
    const items = await page.locator(c.spread).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
    expect(items.length, `${where}: ${c.spread}`).toBeGreaterThan(0);
    for (const [i, r] of items.entries()) {
      expect.soft(r.left, `${where}: шаг ${i + 1} внутри группы слева`).toBeGreaterThanOrEqual(inner.left - 1);
      expect.soft(r.right, `${where}: шаг ${i + 1} внутри группы справа`).toBeLessThanOrEqual(inner.right + 1);
    }
    const span = Math.max(...items.map((r) => r.right)) - Math.min(...items.map((r) => r.left));
    expect.soft(span / (inner.right - inner.left), `${where}: шаги занимают ширину группы`).toBeGreaterThanOrEqual(0.9);
  }
  if (c.maxRem) {
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    // Допуск 3 rem: наклейки и наклон листов выступают за рамку группы.
    expect.soft(box.right - box.left, `${where}: ширина группы`).toBeLessThanOrEqual((c.maxRem + 3) * rem);
  }
  if (c.sideBySide && c.columns) {
    const [a, b] = await Promise.all(c.columns.map((sels) => union(page, sels)));
    if (a && b) expect.soft(b.left - a.right, `${where}: просвет между колонками`).toBeLessThanOrEqual(s.w * 0.1);
  }
  // «Свои люди» на высоком окне («wide-tall»): группа по центру и по вертикали.
  if (c.name === "friends" && s.h >= 900) {
    const g = await verticalGaps(page, c.root);
    expect.soft(Math.abs(g.above - g.below), `${where}: по вертикали по центру (сверху ${Math.round(g.above)}, снизу ${Math.round(g.below)})`).toBeLessThanOrEqual(Math.max(56, s.h * 0.05));
  }
  const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
  expect.soft(doc.w, `${where}: горизонтальная прокрутка`).toBeLessThanOrEqual(s.w);
  // Гостевой кабинет и дуэли на ноутбуке 1366×768 помещаются без прокрутки.
  if (s.w === 1366 && (c.name === "account" || c.name === "duels")) expect.soft(doc.h, `${where}: вертикальная прокрутка`).toBeLessThanOrEqual(s.h);
  await page.screenshot({ path: `test-results/composition/${browserName}-${s.w}x${s.h}-${c.name}.png` });
}

/** Тетрадь лидеров в пустом состоянии: не одна фраза — правила и ранги, без прокрутки внутри листа. */
async function checkLeadersBook(page: Page, where: string) {
  await page.goto("/leaders");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".leaders .book .nb-ranks"), `${where}: ранги на листе`).toBeVisible();
  await settled(page, ".leaders .book");
  const m = await page.evaluate(() => {
    const book = document.querySelector(".leaders .book")!;
    const cs = getComputedStyle(book);
    const r = book.getBoundingClientRect();
    const inner = { top: r.top + parseFloat(cs.paddingTop), bottom: r.bottom - parseFloat(cs.paddingBottom), left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) };
    const part = (sel: string) => {
      const b = document.querySelector(`.leaders .book ${sel}`)!.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    return { overflow: book.scrollHeight - book.clientHeight, inner, main: part(".empty-main"), ranks: part(".nb-ranks"), rows: document.querySelectorAll(".leaders .nb-ranks li").length };
  });
  expect.soft(m.overflow, `${where}: тетрадь не прокручивается внутри`).toBeLessThanOrEqual(1);
  expect.soft(m.rows, `${where}: пять ступеней`).toBe(5);
  for (const [name, b] of [["правила", m.main], ["ранги", m.ranks]] as const) {
    expect.soft(b.left, `${where}: ${name} внутри листа слева`).toBeGreaterThanOrEqual(m.inner.left - 1);
    expect.soft(b.right, `${where}: ${name} внутри листа справа`).toBeLessThanOrEqual(m.inner.right + 1);
  }
  // Содержимое занимает заметную часть листа по ширине и высоте, а не строку вверху.
  const width = Math.max(m.main.right, m.ranks.right) - Math.min(m.main.left, m.ranks.left);
  expect.soft(width / (m.inner.right - m.inner.left), `${where}: ширина листа занята`).toBeGreaterThanOrEqual(0.8);
  expect.soft((Math.max(m.main.bottom, m.ranks.bottom) - m.inner.top) / (m.inner.bottom - m.inner.top), `${where}: высота листа занята`).toBeGreaterThanOrEqual(0.4);
}

for (const s of sizes) {
  test(`${s.w}×${s.h}: содержимое по центру, колонки заполнены`, async ({ page, browserName }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const c of checks) await checkPage(page, c, s, browserName);
    await checkLeadersBook(page, `${s.w}×${s.h} /leaders (гость)`);
  });
}

// Кабинет гостя с кнопками Яндекс ID и VK ID (как на сервере, где они настроены): помещается без
// прокрутки на ноутбучных высотах, а записка «Без кабинета тоже можно» видна только начиная с
// «wide-note» (940 px), где ей хватает места.
test("кабинет: с кнопками входа через сервисы помещается в окно, записка — только когда влезает", async ({ page }) => {
  await page.route("**/api/auth/providers", (r) => r.fulfill({ json: { providers: ["yandex", "vk"] } }));
  for (const s of [{ w: 1366, h: 768 }, { w: 1366, h: 880 }, { w: 1440, h: 900 }, { w: 1536, h: 939 }, { w: 1600, h: 940 }, { w: 1920, h: 1080 }]) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.goto("/account");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /Войти через Яндекс ID/ })).toBeVisible();
    await settled(page, ".guest");
    const m = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, note: getComputedStyle(document.querySelector(".free")!).display !== "none" }));
    const where = `${s.w}×${s.h}`;
    expect.soft(m.h, `${where}: без вертикальной прокрутки`).toBeLessThanOrEqual(s.h);
    expect.soft(m.note, `${where}: записка «Без кабинета тоже можно»`).toBe(s.h >= 940);
  }
});

/** Новый кабинет без друзей и без калибровки (одна регистрация на прогон этого теста). */
async function member(browser: Browser): Promise<Cookie[]> {
  const context = await browser.newContext({ storageState: accepted() });
  const page = await context.newPage();
  await page.goto("/");
  const status = await page.evaluate(async (password) => {
    const email = `composition-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-perepev-request": "1" },
      body: JSON.stringify({ email, name: "Пустая адресная книга", password, consent: true, ageGroup: "14plus" }),
    });
    return res.status;
  }, password);
  expect(status, "регистрация кабинета для проверки композиции").toBe(201);
  const cookies = (await context.storageState()).cookies;
  await context.close();
  return cookies;
}

test("вошедший: пустые «Свои люди» и лидеры заполнены, «Свои люди» по центру на высоком окне", async ({ browser, page, context }) => {
  test.setTimeout(90_000);
  await context.addCookies(await member(browser));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const s of [{ w: 2000, h: 1200 }, { w: 2560, h: 1440 }, { w: 1920, h: 1080 }, { w: 1440, h: 900 }]) {
    const where = `${s.w}×${s.h} /friends (кабинет)`;
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.goto("/friends");
    await expect(page.getByRole("heading", { name: "Здесь будут твои друзья" })).toBeVisible();
    await settled(page, ".friends-page");
    // Три шага стоят на правом листе и заполняют его, а не одна фраза в пустом листе.
    const m = await page.evaluate(() => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return { list: box(document.querySelector(".address-book .list")!), steps: [...document.querySelectorAll(".list .steps.on-paper > .step")].map(box) };
    });
    expect(m.steps.length, `${where}: три шага на листе`).toBe(3);
    for (const [i, r] of m.steps.entries())
      expect.soft(r.left >= m.list.left - 1 && r.right <= m.list.right + 1 && r.top >= m.list.top - 1 && r.bottom <= m.list.bottom + 1, `${where}: шаг ${i + 1} внутри листа`).toBe(true);
    const used = (Math.max(...m.steps.map((r) => r.bottom)) - m.list.top) / (m.list.bottom - m.list.top);
    expect.soft(used, `${where}: лист заполнен шагами`).toBeGreaterThanOrEqual(0.7);
    // По центру по вертикали; вкладка «Заявки» не меняет высоту адресной книги — группа не прыгает.
    const gaps = await verticalGaps(page, ".friends-page");
    expect.soft(Math.abs(gaps.above - gaps.below), `${where}: по вертикали по центру (сверху ${Math.round(gaps.above)}, снизу ${Math.round(gaps.below)})`).toBeLessThanOrEqual(Math.max(56, s.h * 0.05));
    await page.getByRole("button", { name: /Заявки/ }).click();
    await settled(page, ".friends-page");
    const after = await verticalGaps(page, ".friends-page");
    expect.soft(Math.abs(after.above - gaps.above), `${where}: «Заявки» не сдвигают группу`).toBeLessThanOrEqual(1);
    await checkLeadersBook(page, `${s.w}×${s.h} /leaders (кабинет)`);
  }
});
