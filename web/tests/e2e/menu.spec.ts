import { expect, test, type Page } from "@playwright/test";
import { REOPEN_GUARD_MS } from "../../src/lib/ui/menu-history";

// Меню разделов на телефоне (правка владельца: два ряда ярлыков и столбик значков —
// «слишком много кнопок»; с 18.10.2026 по макету — нижнее меню). Шапка: стрелка, логотип
// «Перепев», поиск и кабинет; «Главная», «Песни», «Дуэли» и «Меню» — в нижнем меню. «Меню»
// открывает лист с остальными разделами, поиском, кабинетом и документами. Лист закрывается
// крестиком, Esc, касанием мимо листа и кнопкой «Назад»; фокус возвращается на «Меню».
const sections = [
  ["Главная", /\/$/],
  ["Песни", /\/songs$/],
  ["Дуэли", /\/duels$/],
  ["Лидеры", /\/leaders$/],
  ["Друзья", /\/friends$/],
  ["Мой прогресс", /\/progress$/],
] as const;
// Разделы в листе «Меню» (остальные три — в нижнем меню).
const inSheet = sections.slice(3);
const docs = ["Пользовательское соглашение", "Политика обработки данных", "Согласие на обработку данных", "Cookie", "Музыка и лицензии", "Контакты"];

const menuButton = (page: Page) => page.getByRole("button", { name: "Меню", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Меню" });

async function openMenu(page: Page) {
  await menuButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
  // Страница под листом не прокручивается.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
}

async function expectClosed(page: Page, url: RegExp) {
  await expect(sheet(page)).toBeHidden();
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton(page)).toBeFocused();
  await expect(page).toHaveURL(url);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  // Сразу после закрытия меню не открывается снова (второе касание двойного нажатия на «×»).
  await page.waitForTimeout(REOPEN_GUARD_MS + 50);
}

test.describe("телефон", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("шапка в одну строку: логотип «Перепев», поиск и кабинет; «Меню» — в нижнем меню", async ({ page }) => {
    await page.goto("/leaders");
    await expect(page.locator("header.top").getByRole("navigation", { name: "Основная навигация" })).toBeHidden();
    const items = [page.getByRole("link", { name: "Перепев", exact: true }), page.getByRole("link", { name: "Поиск песни", exact: true }), page.getByRole("link", { name: "Войти", exact: true })];
    const boxes = [];
    for (const item of items) {
      await expect(item).toBeVisible();
      const box = (await item.boundingBox())!;
      expect(box.height, "цель нажатия не ниже 44 px").toBeGreaterThanOrEqual(44);
      expect(box.width, "цель нажатия не уже 44 px").toBeGreaterThanOrEqual(44);
      boxes.push(box);
    }
    const middles = boxes.map((b) => b.y + b.height / 2);
    expect(Math.max(...middles) - Math.min(...middles), "все элементы шапки в одной строке").toBeLessThan(6);
    await expect(menuButton(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-controls", "site-menu");
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    const menu = (await menuButton(page).boundingBox())!;
    expect(menu.height).toBeGreaterThanOrEqual(44);
    expect(Math.round(menu.y + menu.height), "«Меню» у нижнего края").toBe(844);
    const header = (await page.locator("header.top").boundingBox())!;
    expect(header.height).toBeLessThan(80);
  });

  test("лист закрывается крестиком, Esc, касанием мимо и кнопкой «Назад»", async ({ page }) => {
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    await openMenu(page);
    // Текущий раздел отмечен.
    await expect(sheet(page).getByRole("link", { name: "Лидеры" })).toHaveAttribute("aria-current", "page");
    await expect(sheet(page).getByRole("link", { name: "Войти или зарегистрироваться" })).toBeVisible();
    await sheet(page).getByRole("button", { name: "Закрыть меню" }).click();
    await expectClosed(page, /\/leaders$/);

    await openMenu(page);
    await page.keyboard.press("Escape");
    await expectClosed(page, /\/leaders$/);

    await openMenu(page);
    // Под листом: касание попадает в сам <dialog>, а не в страницу.
    await page.mouse.click(195, 800);
    await expectClosed(page, /\/leaders$/);

    await openMenu(page);
    await page.goBack();
    await expectClosed(page, /\/leaders$/);
    // «Назад» закрыл только меню: страница та же, а не предыдущая.
    await expect(page.getByRole("heading", { name: "Топ игроков" })).toBeVisible();
  });

  // Ревью: закрытие должно срабатывать один раз. Двойное касание крестика или мимо листа и
  // двойной Esc раньше дважды шли «Назад» и уводили со страницы.
  test("двойное касание и двойной Esc закрывают меню один раз, страница остаётся", async ({ page }) => {
    await page.goto("/songs");
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    const ways: [string, () => Promise<void>][] = [
      ["двойное касание крестика", () => sheet(page).getByRole("button", { name: "Закрыть меню" }).dblclick()],
      // Над листом (он поднимается от нижнего меню), под точкой на странице не ссылка: второе
      // касание проходит на страницу и ничего не нажимает.
      ["двойное касание мимо листа", () => page.mouse.dblclick(330, 150)],
      ["Esc дважды", async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); }],
    ];
    for (const [way, close] of ways) {
      await openMenu(page);
      await close();
      await page.waitForTimeout(700);
      await expect(page, way).toHaveURL(/\/leaders$/);
      await expect(page.getByRole("heading", { name: "Топ игроков" }), way).toBeVisible();
      await expect(sheet(page), way).toBeHidden();
      await page.waitForTimeout(REOPEN_GUARD_MS);
    }
  });

  // Ревью: пока лист гаснет (~220 мс), прозрачный <dialog> на весь экран съедал касание.
  test("касание сразу после закрытия попадает в страницу", async ({ page }) => {
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    await openMenu(page);
    const brand = (await page.getByRole("link", { name: "Перепев", exact: true }).boundingBox())!;
    await sheet(page).getByRole("button", { name: "Закрыть меню" }).click();
    // Лист уже закрыт (нет [open]), но ещё гаснет: касание должно пройти на страницу.
    await page.waitForFunction(() => !document.querySelector("#site-menu")!.hasAttribute("open"), null, { polling: "raf" });
    await page.mouse.click(brand.x + brand.width / 2, brand.y + brand.height / 2);
    await expect(page).toHaveURL(/\/$/);
  });

  // Ревью: лист закрывался до того, как переход состоялся. Пока переход идёт (или если его
  // отменили — beforeNavigate живого матча), меню должно оставаться открытым и рабочим, а не
  // «aria-expanded=true» без листа и с мёртвой кнопкой «Меню».
  test("переход из меню ещё идёт: лист открыт, после него меню снова работает", async ({ page }) => {
    await page.goto("/songs");
    await page.waitForLoadState("networkidle");
    const held: import("@playwright/test").Route[] = [];
    let released = false;
    await page.route("**/_app/immutable/nodes/**", (route) => (released ? route.continue() : void held.push(route)));
    await openMenu(page);
    await sheet(page).getByRole("link", { name: "Лидеры", exact: true }).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/songs$/);
    await expect(sheet(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    released = true;
    for (const r of held.splice(0)) await r.continue();
    await expect(page).toHaveURL(/\/leaders$/);
    await expect(sheet(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await openMenu(page);
    await sheet(page).getByRole("button", { name: "Закрыть меню" }).click();
    await expectClosed(page, /\/leaders$/);
  });

  // Ревью: при повороте телефона или расширении окна шапка снова с вкладками, а меню оставалось
  // открытым листом на весь экран.
  test("поворот в ландшафт закрывает меню", async ({ page }) => {
    await page.goto("/friends");
    await page.waitForLoadState("networkidle");
    await openMenu(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(sheet(page)).toBeHidden();
    await expect(page).toHaveURL(/\/friends$/);
    await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  });

  test("ссылка на текущую страницу закрывает меню; после перехода страница снова прокручивается", async ({ page }) => {
    await page.goto("/songs");
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    await openMenu(page);
    await sheet(page).getByRole("link", { name: "Лидеры", exact: true }).click();
    await expectClosed(page, /\/leaders$/);
    await expect(page.getByRole("heading", { name: "Топ игроков" })).toBeVisible();
    // Запись меню снята, а не добавлена: «Назад» ведёт на прежнюю страницу.
    await page.goBack();
    await expect(page).toHaveURL(/\/songs$/);
    await openMenu(page);
    await sheet(page).getByRole("link", { name: "Друзья", exact: true }).click();
    await expect(page).toHaveURL(/\/friends$/);
    await expect(sheet(page)).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
    expect(await page.evaluate(() => { scrollTo(0, 300); return scrollY; })).toBeGreaterThan(0);
  });

  test("клавиатура: Enter открывает, фокус внутри листа, Esc закрывает", async ({ page, browserName }) => {
    await page.goto("/friends");
    await page.waitForLoadState("networkidle");
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(sheet(page)).toBeVisible();
    // Фокус в листе: крестик, поиск, три раздела, кабинет, документы. Страница под листом
    // недоступна (модальный <dialog>), после последней ссылки Tab уходит в интерфейс браузера.
    expect(await page.evaluate(() => document.activeElement?.classList.contains("menu-sheet"))).toBe(true);
    const order: string[] = [];
    for (let i = 0; i < 15; i++) {
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return "body";
        return a.closest("#site-menu") ? (a.textContent?.trim() || a.getAttribute("aria-label") || "?") : "СТРАНИЦА";
      });
      expect(where, `Tab ${i}`).not.toBe("СТРАНИЦА");
      order.push(where);
      await page.keyboard.press("Tab");
    }
    // Safari по умолчанию пропускает ссылки при Tab (настройка «Tab выделяет каждый объект»).
    if (browserName === "chromium") expect(order.slice(1, 13)).toEqual(["Закрыть меню", "Поиск песни", ...inSheet.map(([s]) => s), "Войти или зарегистрироваться", ...docs]);
    await page.keyboard.press("Escape");
    await expectClosed(page, /\/friends$/);
  });

  test("каждый раздел и кабинет открываются из меню; «Назад» ведёт на прежнюю страницу без меню", async ({ page }) => {
    await page.goto("/legal/terms");
    await page.waitForLoadState("networkidle");
    let from: RegExp = /\/legal\/terms$/;
    for (const [label, url] of [...sections.slice(0, 3)] as const) {
      await page.locator("nav.tabbar").getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(url);
      await page.goBack();
      await expect(page).toHaveURL(from);
      await page.goForward();
      await expect(page).toHaveURL(url);
      from = url;
    }
    for (const [label, url] of [...inSheet, ["Войти или зарегистрироваться", /\/account$/] as const]) {
      await openMenu(page);
      await sheet(page).getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(url);
      await expect(sheet(page)).toBeHidden();
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await page.goBack();
      await expect(page).toHaveURL(from);
      await expect(sheet(page)).toBeHidden();
      await page.goForward();
      await expect(page).toHaveURL(url);
      from = url;
    }
  });
});

test("компьютер: вкладки разделов как раньше, без кнопки «Меню»", async ({ page }) => {
  await page.goto("/songs");
  const nav = page.getByRole("navigation", { name: "Основная навигация" });
  await expect(nav).toBeVisible();
  for (const [label] of sections) await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  await expect(menuButton(page)).toBeHidden();
  await expect(page.getByRole("link", { name: "Перепев", exact: true })).toBeHidden();
});
