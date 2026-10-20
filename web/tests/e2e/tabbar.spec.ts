// Нижнее меню телефона (макет владельца 18.10.2026): «Главная», «Песни», «Дуэли», «Меню».
// На каждом экране телефона отмечен нужный пункт; во время пения скрыто; «Меню» открывает лист
// одним шагом истории; меню не закрывает поля ввода и панель «Петь», учитывает полоску «домой»;
// на ландшафте телефона, планшете от 800 px и компьютере его нет.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { REOPEN_GUARD_MS } from "../../src/lib/ui/menu-history";
import { fakeMic } from "./fake-mic";
import { player } from "./helpers";

const bar = (page: Page) => page.locator("nav.tabbar");
const menuButton = (page: Page) => bar(page).getByRole("button", { name: "Меню", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Меню" });

/** Закреплённые (fixed/sticky) элементы, которые заходят на нижнее меню: их не должно быть. */
async function overBar(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav.tabbar")!;
    const b = nav.getBoundingClientRect();
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (nav.contains(el) || el.closest(".wall") || cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0" || cs.pointerEvents === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom > b.top + 0.5 && r.top < b.bottom && r.right > b.left && r.left < b.right) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} [${Math.round(r.top)}-${Math.round(r.bottom)}]`);
    }
    return out;
  });
}

/** Экранная клавиатура в эмуляции: окно становится ниже на её высоту (как при сжатии макета). */
async function keyboard(page: Page, open: boolean, size: { width: number; height: number }) {
  await page.setViewportSize(open ? { width: size.width, height: size.height - 340 } : size);
  await page.waitForTimeout(150);
}

/** Свой трек на заглушках API (как tracks-lyrics.spec.ts): редактор текста с панелью «Сохранить». */
const UUID = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
async function mockTrack(page: Page) {
  const songFile = (name: string) => readFileSync(new URL(`../../static/songs/cn-earth/${name}`, import.meta.url));
  const lines = Array.from({ length: 6 }, (_, i) => [{ text: `строка${i + 1}`, start_s: 1 + i * 2, end_s: 2.5 + i * 2 }]);
  const base = JSON.parse(songFile("reference.json").toString("utf8"));
  const reference = { ...base, id: `my-${UUID}`, title: "Моя песня", lyrics: lines.map((l) => ({ t: l[0].start_s, text: l[0].text })), phrases: lines.map((l) => ({ start_s: l[0].start_s, end_s: l[0].end_s })) };
  const words = { v: 1, lines: lines.map((l, i) => ({ line: i, words: l })) };
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile: { id: "00000000-0000-4000-8000-000000000003", name: "Певец-4321", email: null, hasPassword: false, providers: ["vk"] } } }));
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tracks") return route.fulfill({ json: { tracks: [{ id: UUID, title: "Моя песня", language: "ru", status: "ready", stage: null, error: null, expiresAt: new Date(Date.now() + 72e6).toISOString() }] } });
    const file = new RegExp(`^/api/tracks/${UUID}/files/(.+)$`).exec(path);
    if (file?.[1] === "reference.json") return route.fulfill({ json: reference });
    if (file?.[1] === "lyrics.words.json") return route.fulfill({ json: words });
    if (file) return route.fulfill({ body: songFile("backing.mp3"), contentType: "audio/mpeg" });
    return route.fulfill({ status: 404, json: { error: "Трек не найден." } });
  });
}

/** Какой пункт отмечен: ссылка с aria-current="page" или «Меню» (класс current). */
async function activeTab(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav.tabbar")!;
    const link = nav.querySelector('[aria-current="page"]');
    if (link) return link.textContent!.trim();
    return nav.querySelector("button.current") ? "Меню" : null;
  });
}

test.describe("телефон 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("на каждом экране отмечен свой пункт, цели нажатия не меньше 44 px, без горизонтальной прокрутки", async ({ page }) => {
    const screens: [string, string | null][] = [
      ["/", "Главная"],
      ["/songs", "Песни"],
      ["/sing/cn-earth", "Песни"],
      ["/result", "Песни"],
      ["/practice", "Песни"],
      ["/duels", "Дуэли"],
      ["/leaders", "Меню"],
      ["/friends", "Меню"],
      ["/progress", "Меню"],
      ["/account", "Меню"],
      ["/legal/privacy", "Меню"],
      ["/no-such-page", null],
    ];
    for (const [route, tab] of screens) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(bar(page), route).toBeVisible();
      await expect(bar(page), route).toHaveAttribute("aria-label", "Основная навигация");
      expect(await activeTab(page), `${route}: отмеченный пункт`).toBe(tab);
      // «Меню» отмечено и для экранного чтения, когда открыт один из его разделов.
      if (tab === "Меню") await expect(menuButton(page), route).toHaveAttribute("aria-current", "true");
      else await expect(menuButton(page), route).not.toHaveAttribute("aria-current", /.*/);
      const box = (await bar(page).boundingBox())!;
      expect(Math.round(box.y + box.height), `${route}: меню у нижнего края`).toBe(844);
      for (const item of await bar(page).locator("a, button").all()) {
        const b = (await item.boundingBox())!;
        expect(b.height, `${route}: высота пункта`).toBeGreaterThanOrEqual(44);
        expect(b.width, `${route}: ширина пункта`).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${route}: горизонтальная прокрутка`).toBeLessThanOrEqual(390);
      // Конец страницы не прячется под меню: подвал над ним после прокрутки вниз.
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const foot = await page.locator("footer.foot").boundingBox();
      if (foot) expect(foot.y + foot.height, `${route}: подвал над нижним меню`).toBeLessThanOrEqual(box.y + 0.5);
    }
  });

  test("шапка: стрелка к родительскому экрану, логотип и круглые кнопки", async ({ page }) => {
    const heads: [string, string | null, string[]][] = [
      ["/", null, ["Поиск песни", "Войти"]],
      ["/songs", "Назад: главная", ["Поиск песни"]],
      ["/sing/cn-earth", "Назад: выбор песни", []],
      ["/leaders", "Назад: главная", ["Поиск песни", "Войти"]],
    ];
    for (const [route, back, icons] of heads) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const header = page.locator("header.top");
      await expect(header.getByRole("link", { name: "Перепев", exact: true })).toBeVisible();
      if (back) await expect(header.getByRole("link", { name: back })).toBeVisible();
      else await expect(header.locator(".back-link")).toHaveCount(0);
      for (const name of ["Поиск песни", "Войти"]) {
        const icon = header.getByRole("link", { name, exact: true });
        if (icons.includes(name)) await expect(icon, `${route}: ${name}`).toBeVisible();
        else await expect(icon, `${route}: ${name}`).toBeHidden();
      }
      const h = (await header.boundingBox())!;
      expect(h.height, `${route}: шапка компактная`).toBeLessThan(80);
    }
    await page.goto("/songs");
    await page.locator("header.top").getByRole("link", { name: "Назад: главная" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("«Меню»: лист с остальными разделами, один шаг истории, Назад закрывает только меню", async ({ page }) => {
    await page.goto("/songs");
    await page.goto("/duels");
    await page.waitForLoadState("networkidle");
    const length = await page.evaluate(() => history.length);
    await menuButton(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Поиск песни", "Лидеры", "Друзья", "Мой прогресс", "Войти или зарегистрироваться", "Политика обработки данных"])
      await expect(sheet(page).getByRole("link", { name, exact: true })).toBeVisible();
    // Лист над нижним меню, а не под ним.
    const s = (await sheet(page).locator(".menu-sheet").boundingBox())!;
    const b = (await bar(page).boundingBox())!;
    expect(s.y + s.height).toBeLessThanOrEqual(b.y + 0.5);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    // Касание по «Меню» (под затемнением) закрывает лист: страница та же, шаг истории снят.
    await page.mouse.click(b.x + b.width * 0.875, b.y + b.height / 2);
    await expect(sheet(page)).toBeHidden();
    await expect(page).toHaveURL(/\/duels$/);
    await expect(menuButton(page)).toBeFocused();
    await page.waitForTimeout(REOPEN_GUARD_MS + 50);
    await page.goBack();
    await expect(page).toHaveURL(/\/songs$/);
    // Раздел из меню заменяет запись меню: «Назад» ведёт на прежнюю страницу.
    await menuButton(page).click();
    await sheet(page).getByRole("link", { name: "Лидеры", exact: true }).click();
    await expect(page).toHaveURL(/\/leaders$/);
    await expect(sheet(page)).toBeHidden();
    expect(await activeTab(page)).toBe("Меню");
    await page.goBack();
    await expect(page).toHaveURL(/\/songs$/);
    await expect(sheet(page)).toBeHidden();
  });

  test("«Поиск песни» из меню: песни сверху, курсор в поле; меню прячется только при клавиатуре", async ({ page }) => {
    const size = { width: 390, height: 844 };
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    await menuButton(page).click();
    await sheet(page).getByRole("link", { name: "Поиск песни", exact: true }).click();
    await expect(page).toHaveURL(/\/songs#search$/);
    await expect(page.locator("#search")).toBeFocused();
    await expect(page.locator("#search")).toHaveAttribute("placeholder", "Название или исполнитель");
    expect(await page.evaluate(() => scrollY)).toBe(0);
    // Фокус из кода клавиатуру не открывает (iOS): нижнее меню остаётся.
    await page.waitForTimeout(300);
    await expect(bar(page)).toBeVisible();
    // Клавиатура открылась (видимая область ниже на 340 px): меню скрыто, его место и отступы обнулены.
    await keyboard(page, true, size);
    await expect(bar(page)).toBeHidden();
    const open = await page.evaluate(() => ({ space: getComputedStyle(document.documentElement).getPropertyValue("--bar-space").trim(), pad: getComputedStyle(document.querySelector(".shell")!).paddingBottom }));
    expect(open).toEqual({ space: "0px", pad: "0px" });
    await keyboard(page, false, size);
    await expect(bar(page)).toBeVisible();
    // Клавиатура открыта, но фокус ушёл из поля (например, касание по странице): меню вернулось.
    await page.locator("#search").focus();
    await keyboard(page, true, size);
    await expect(bar(page)).toBeHidden();
    await page.locator("#search").blur();
    await expect(bar(page)).toBeVisible();
    await keyboard(page, false, size);
    // Фокус на кнопке (не поле для текста) клавиатуру не открывает: меню не прячется и при сжатии окна.
    await page.locator('.sections button').first().focus();
    await keyboard(page, true, size);
    await expect(bar(page)).toBeVisible();
    await keyboard(page, false, size);
  });

  test("песни: панель «Петь» прилипает над нижним меню и не перекрывает его", async ({ page }) => {
    await page.goto("/songs");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".songs .song")).not.toHaveCount(0);
    const deck = page.locator(".deck");
    const b = (await bar(page).boundingBox())!;
    for (const y of [0, 600, 1500]) {
      await page.evaluate((y) => scrollTo(0, y), y);
      await page.waitForTimeout(100);
      const d = (await deck.boundingBox())!;
      expect(d.y + d.height, `прокрутка ${y}: панель над меню`).toBeLessThanOrEqual(b.y + 0.5);
      expect(d.y, `прокрутка ${y}: панель в окне`).toBeGreaterThanOrEqual(0);
    }
    // В конце списка последняя песня видна целиком над панелью «Петь», панель — над меню.
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(100);
    const lastRow = (await page.locator(".songs .song").last().boundingBox())!;
    const endDeck = (await deck.boundingBox())!;
    expect(lastRow.y, "последняя песня в окне").toBeGreaterThanOrEqual(0);
    expect(lastRow.y + lastRow.height, "последняя песня над панелью").toBeLessThanOrEqual(endDeck.y + 0.5);
    expect(endDeck.y + endDeck.height, "панель над меню").toBeLessThanOrEqual(b.y + 0.5);
    await page.evaluate(() => scrollTo(0, 0));
    // Выбранная песня — в панели; «Петь» ведёт на проверку микрофона.
    const second = page.locator(".songs .song").nth(1);
    await second.click();
    await expect(second).toHaveClass(/checked/);
    const title = (await second.locator(".caption > .title").textContent())!.trim();
    await expect(deck.locator(".label-strip strong")).toHaveText(title);
    await deck.getByRole("button", { name: `Петь «${title}»` }).click();
    await expect(page).toHaveURL(/\/sing\//);
  });

  test("полоска «домой»: нижнее меню и отступ страницы растут на её высоту", async ({ page }) => {
    await page.goto("/leaders");
    await page.waitForLoadState("networkidle");
    // В эмуляции env(safe-area-inset-bottom) равен нулю: подставляем 34 px, как у iPhone.
    await page.addStyleTag({ content: ":root { --safe-bottom: 34px !important; }" });
    const m = await page.evaluate(() => {
      const nav = document.querySelector("nav.tabbar")!;
      const shell = document.querySelector(".shell")!;
      return { h: nav.getBoundingClientRect().height, pad: getComputedStyle(nav).paddingBottom, shell: getComputedStyle(shell).paddingBottom };
    });
    expect(m).toEqual({ h: 94, pad: "34px", shell: "94px" });
  });

  test("во время пения меню скрыто (и на паузе), на итоге снова на месте", async ({ page, context, browserName }) => {
    test.setTimeout(90_000);
    await fakeMic(context, "cn-earth", { shift: -2 });
    await page.goto("/sing/cn-earth");
    await expect(bar(page)).toBeVisible();
    await page.getByRole("button", { name: /Включить микрофон/ }).click();
    await page.getByRole("button", { name: /Начать пение/ }).click();
    await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
    await expect(bar(page)).toBeHidden();
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    await expect(page.getByText("Пауза", { exact: true })).toBeVisible();
    // На паузе клавиши плеера («Продолжить», «Начать заново», «Выйти») в окне, меню не появляется.
    await expect(bar(page)).toBeHidden();
    for (const name of ["Продолжить", "Начать заново", "Выйти"]) await expect(page.getByRole("button", { name, exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
    await expect(bar(page)).toBeVisible();
    expect(await activeTab(page)).toBe("Песни");
    // Тренировка: пока фрагмент звучит, меню скрыто; после остановки — снова на месте. Только
    // Chromium: синтетический микрофон в WebKit не отдаёт второй захват («Нет доступа к микрофону»).
    if (browserName !== "chromium") return;
    for (let i = 0; i < 8 && (await page.getByRole("button", { name: "Закрыть достижение" }).count()); i++) await page.getByRole("button", { name: "Закрыть достижение" }).first().click();
    await page.getByRole("button", { name: "Разбор и ошибки" }).first().click();
    await page.getByRole("button", { name: "Потренировать" }).first().click();
    await expect(page.getByText("Тренировка без оценки")).toBeVisible();
    await expect(bar(page)).toBeVisible();
    await page.getByRole("button", { name: "Спеть фрагмент" }).click();
    await expect(page.getByRole("button", { name: "Остановить" })).toBeVisible();
    await expect(bar(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Остановить" })).toBeInViewport();
    await page.getByRole("button", { name: "Остановить" }).click();
    await expect(page.getByRole("button", { name: "Спеть фрагмент" })).toBeVisible();
    await expect(bar(page)).toBeVisible();
  });

  test("дуэль с другом: меню на подготовке, скрыто на сцене, снова на итоге", async ({ browser, browserName }) => {
    // Как остальные сценарии дуэлей — только Chromium: player() выдаёт права на буфер обмена,
    // которых WebKit не знает.
    test.skip(browserName !== "chromium", "дуэли проверяются в Chromium");
    test.setTimeout(180_000);
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    const a = await player(browser, "Аня", "cn-earth", { shift: -5 }, phone);
    const b = await player(browser, "Борис", "cn-earth", { shift: 4 }, phone);
    await a.page.goto("/duels");
    expect(await activeTab(a.page)).toBe("Дуэли");
    await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
    await a.page.getByRole("button", { name: "Создать комнату" }).click();
    await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
    await expect(bar(a.page)).toBeVisible();
    const code = (await a.page.locator(".code").textContent())!.trim();
    await b.page.goto(`/duels/room/${code}`);
    for (const p of [a.page, b.page]) {
      await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
      await expect(bar(p)).toBeVisible();
      expect(await activeTab(p)).toBe("Дуэли");
      expect(await overBar(p)).toEqual([]);
    }
    for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Я готов" }).click();
    for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
    for (const p of [a.page, b.page]) {
      await expect(bar(p)).toBeHidden();
      await expect(p.getByRole("button", { name: "Выйти" })).toBeInViewport();
    }
    for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 60_000 });
    for (const p of [a.page, b.page]) await expect(bar(p)).toBeVisible();
    await a.context.close();
    await b.context.close();
  });
});

test.describe("768×1024 (узкий планшет в портрете)", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

  test("нижнее меню на месте, закреплённые панели не заходят на него", async ({ page }) => {
    const screens: [string, string | null][] = [
      ["/", "Главная"],
      ["/songs", "Песни"],
      ["/sing/cn-earth", "Песни"],
      ["/result", "Песни"],
      ["/duels", "Дуэли"],
      ["/leaders", "Меню"],
      ["/account", "Меню"],
      ["/legal/privacy", "Меню"],
    ];
    for (const [route, tab] of screens) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(bar(page), route).toBeVisible();
      await expect(page.locator("header.top nav"), route).toBeHidden();
      expect(await activeTab(page), route).toBe(tab);
      for (const at of [0, 0.5, 1]) {
        await page.evaluate((at) => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * at), at);
        await page.waitForTimeout(80);
        expect(await overBar(page), `${route}, прокрутка ${at}`).toEqual([]);
      }
    }
  });

  test("редактор текста: панель «Сохранить» над нижним меню", async ({ page }) => {
    await mockTrack(page);
    await page.goto(`/tracks/${UUID}/lyrics`);
    await expect(page.getByRole("heading", { name: "Текст и тайминги" })).toBeVisible();
    await expect(bar(page)).toBeVisible();
    expect(await activeTab(page)).toBe("Песни");
    const save = page.locator(".actions");
    await expect(save).toHaveCSS("position", "sticky");
    for (const at of [0, 0.5]) {
      await page.evaluate((at) => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * at), at);
      await page.waitForTimeout(80);
      const s = (await save.boundingBox())!;
      const b = (await bar(page).boundingBox())!;
      expect(s.y + s.height, `прокрутка ${at}: «Сохранить» над меню`).toBeLessThanOrEqual(b.y + 0.5);
      expect(await overBar(page), `прокрутка ${at}`).toEqual([]);
    }
  });
});

test.describe("360×740", () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

  test("подписи пунктов помещаются, без горизонтальной прокрутки", async ({ page }) => {
    for (const route of ["/", "/songs", "/duels", "/leaders"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(360);
      const clipped = await bar(page).evaluate((nav) => [...nav.querySelectorAll(".tab-label")].filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent));
      expect(clipped, route).toEqual([]);
    }
  });
});

for (const size of [{ width: 844, height: 390 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }]) {
  test(`${size.width}×${size.height}: нижнего меню нет, вкладки в шапке`, async ({ browser }) => {
    const touch = size.width < 1100;
    const context = await browser.newContext({ viewport: size, isMobile: touch && size.height < 521, hasTouch: touch });
    const page = await context.newPage();
    await page.goto("/songs");
    await page.waitForLoadState("networkidle");
    await expect(bar(page)).toBeHidden();
    await expect(page.locator("header.top nav")).toBeVisible();
    await expect(page.locator(".back-link")).toBeHidden();
    await context.close();
  });
}
