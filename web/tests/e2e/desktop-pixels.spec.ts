// Настольная версия не меняется, пока переделывается телефонная (требование владельца
// 18.10.2026: «главное компьютерную версию не сломай, когда делаешь мобильную»).
//
// Снимки всех страниц и состояний, доступных гостю и вошедшему, на настольных размерах и
// планшетах в ландшафте. Два прогона (до и после правок) сравниваются попиксельно скриптом
// tests/desktop-pixels-compare.mjs; ожидаемая разница — ноль.
//
// Чтобы прогоны были сравнимы:
// - ответы GET /api/* первого прогона записываются (PIXELS_RECORD=1) и подставляются во втором:
//   таблица лидеров, друзья, история и матчи одинаковы, сколько бы другие сценарии ни меняли базу;
// - часы страницы остановлены (Date.now) на моменте раньше любых данных: «ждём N с» в поиске
//   соперника остаётся нулём, подписи дат не зависят от дня прогона;
// - анимации выключены (prefers-reduced-motion и animations: "disabled"), отложенные картинки
//   загружаются до снимка;
// - живые области закрыты одинаковой маской в обоих прогонах: график голоса и индикатор уровня
//   (идут в реальном времени), случайный код комнаты и всё, что зависит от балла синтетического
//   певца на итоге и в разборе (балл, оси, вывод, кот с подписью, линия разбора): певец поёт
//   в реальном времени, и балл двух прогонов одной сборки отличается на 1-2 пункта (и тексты
//   трудных мест: «на 141 / 169 центов выше»).
//
// Запуск (сайт и API уже запущены, BASE_URL указывает на сайт):
//   PIXELS_DIR=<папка снимков> PIXELS_API=<папка записанных ответов> PIXELS_RECORD=1 \
//     npx playwright test desktop-pixels --workers=1        # до правок: снимки и запись ответов
//   PIXELS_DIR=<другая папка> PIXELS_API=<та же папка ответов> \
//     npx playwright test desktop-pixels --workers=1        # после правок: те же ответы
//   node tests/desktop-pixels-compare.mjs <папка до> <папка после>
// PIXELS_SET=phone снимает те же экраны телефоном (390×844, 360×740, 844×390, сенсорный экран)
// для отчёта «до и после» о телефонной раскладке; эти снимки не сравниваются попиксельно.
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeMic } from "./fake-mic";
import { password } from "./helpers";
import { documents } from "../../src/lib/legal/operator";

const OUT = process.env.PIXELS_DIR ?? "";
const API = process.env.PIXELS_API ?? (OUT ? join(OUT, "..", "api") : "");
const RECORD = process.env.PIXELS_RECORD === "1";
const ORIGIN = process.env.BASE_URL ?? "http://127.0.0.1:4173";
// Раньше любых записанных данных (матчи, попытки, поиск соперника — 18.10.2026 и позже).
const FIXED = new Date("2026-10-18T00:00:00Z");
const PHONE = process.env.PIXELS_SET === "phone";

type Size = [number, number];
// Ноутбуки и мониторы (wide), планшеты в ландшафте (medium, без телефонной раскладки).
const SIZES: Record<string, Size[]> = PHONE
  ? { chromium: [[390, 844], [360, 740], [844, 390]], webkit: [[390, 844], [360, 740], [844, 390]] }
  : {
      chromium: [[1024, 768], [1180, 820], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]],
      webkit: [[1024, 768], [1366, 768], [1920, 1080]],
    };

test.skip(!OUT, "PIXELS_DIR не задан: сценарий запускается только для сравнения настольной версии");
test.describe.configure({ mode: "serial" });
// Растр Chromium по умолчанию недетерминирован между запусками: крупные картинки декодируются
// асинхронно (checker imaging) — кресло и кот то резкие, то размытые, до 60 уровней по краям, — а
// фон комнаты (большая картинка с CSS-фильтром) расходится на 1-3 уровня по всему окну. Синхронное
// декодирование и растр в одном потоке без GPU делают снимки двух прогонов одной сборки равными.
// Остальные флаги — как у проекта chromium.
test.use({
  launchOptions: [
    async ({ browserName }, use) =>
      use(browserName === "chromium" ? { args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-checker-imaging", "--disable-gpu-rasterization", "--disable-oop-rasterization", "--num-raster-threads=1", "--disable-partial-raster"] } : {}),
    { scope: "worker" },
  ],
});

type Saved = { status: number; contentType: string; body: string };

/** Запись и подстановка GET /api/* (не WebSocket): по пути с запросом, по порядку обращений. */
async function apiTape(context: BrowserContext, name: string) {
  const file = join(API, `${PHONE ? "phone-" : ""}${name}.json`);
  if (!RECORD && !existsSync(file)) throw new Error(`Нет записанных ответов ${file}: сначала прогон с PIXELS_RECORD=1`);
  const tape: Record<string, Saved[]> = RECORD ? {} : JSON.parse(readFileSync(file, "utf8"));
  const used: Record<string, number> = {};
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    const key = url.pathname + url.search;
    if (RECORD) {
      const response = await route.fetch();
      const body = await response.text();
      (tape[key] ??= []).push({ status: response.status(), contentType: response.headers()["content-type"] ?? "", body });
      return route.fulfill({ response, body });
    }
    const list = tape[key];
    if (!list) return route.fallback();
    const i = used[key] ?? 0;
    used[key] = i + 1;
    const saved = list[Math.min(i, list.length - 1)];
    return route.fulfill({ status: saved.status, contentType: saved.contentType, body: saved.body });
  });
  return {
    save() {
      if (!RECORD) return;
      mkdirSync(API, { recursive: true });
      writeFileSync(file, JSON.stringify(tape));
    },
  };
}

type Storage = "accepted" | "no-consent" | "empty";
async function newContext(browser: Browser, storage: Storage): Promise<BrowserContext> {
  const items =
    storage === "empty"
      ? []
      : storage === "no-consent"
        ? [{ name: "perepev.cookies", value: "test" }]
        : [{ name: "perepev.cookies", value: "test" }, { name: "perepev.voiceConsent", value: documents.consent }];
  const phone = PHONE ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {};
  const context = await browser.newContext({ ...phone, reducedMotion: "reduce", storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: items }] } });
  await context.clock.setFixedTime(FIXED);
  return context;
}

/** Шрифты загружены, отложенные картинки загружены и раскодированы, страница сверху. Догружаются
 *  только отрисованные картинки: скрытые (display: none, например телефонные на компьютере) браузер
 *  не грузит и сам, а их загрузка меняла кэш картинок WebKit, и фон следующих страниц растрировался
 *  иначе (тренировка 1366×768: 133 607 слабых отличий фона при попиксельно равной странице). */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const img of document.images) if (img.loading === "lazy" && img.getClientRects().length) img.loading = "eager";
    await Promise.all([...document.images].filter((img) => img.getClientRects().length).map((img) => (img.complete ? null : img.decode().catch(() => {}))));
    scrollTo(0, 0);
  });
  await page.waitForTimeout(350);
}

async function shot(page: Page, name: string, [w, h]: Size, mask: Locator[] = []) {
  await settle(page);
  const browser = page.context().browser()?.browserType().name() ?? "unknown";
  mkdirSync(OUT, { recursive: true });
  // Снимки телефона — для просмотра глазами, без масок.
  await page.screenshot({ path: join(OUT, `${browser}-${name}-${w}x${h}.png`), fullPage: true, animations: "disabled", caret: "hide", mask: PHONE ? [] : mask, maskColor: "#ff00ff" });
}

/** Адрес открывается заново на каждом размере. */
async function routes(page: Page, sizes: Size[], list: [string, string][], ready?: (route: string) => Promise<void>) {
  for (const [route, name] of list)
    for (const size of sizes) {
      await page.setViewportSize({ width: size[0], height: size[1] });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      if (ready) await ready(route);
      await shot(page, name, size);
    }
}

/** Тот же экран (состояние страницы) на всех размерах. */
async function resized(page: Page, sizes: Size[], name: string, mask: () => Locator[] = () => []) {
  for (const size of sizes) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await shot(page, name, size, mask());
  }
}

const guestRoutes: [string, string][] = [
  ["/", "home"],
  ["/songs", "songs"],
  ["/account", "account"],
  ["/progress", "progress"],
  ["/leaders", "leaders"],
  ["/friends", "friends"],
  ["/duels", "duels"],
  ["/practice", "practice-empty"],
  ["/sing/cn-earth", "sing-mic"],
  ["/legal/terms", "legal-terms"],
  ["/legal/privacy", "legal-privacy"],
  ["/legal/consent", "legal-consent"],
  ["/legal/cookies", "legal-cookies"],
  ["/legal/music", "legal-music"],
  ["/legal/contacts", "legal-contacts"],
  ["/no-such-page", "404"],
];

test("гость: все страницы", async ({ browser, browserName }) => {
  test.setTimeout(600_000);
  const context = await newContext(browser, "accepted");
  const tape = await apiTape(context, `${browserName}-guest`);
  const page = await context.newPage();
  await routes(page, SIZES[browserName], guestRoutes, async (route) => {
    if (route === "/sing/cn-earth") await expect(page.getByRole("button", { name: /Включить микрофон/ })).toBeVisible();
  });
  // Телефон: открытый лист «Меню» (снимок окна: лист закреплён у нижнего края).
  if (PHONE)
    for (const size of SIZES[browserName].filter(([w]) => w < 600)) {
      await page.setViewportSize({ width: size[0], height: size[1] });
      await page.goto("/leaders");
      await page.waitForLoadState("networkidle");
      const menu = page.locator("nav.tabbar").getByRole("button", { name: "Меню", exact: true });
      if (!(await menu.isVisible())) break;
      await menu.click();
      await expect(page.getByRole("dialog", { name: "Меню" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${browserName}-menu-open-${size[0]}x${size[1]}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }
  tape.save();
  await context.close();
});

test("первый визит: уведомление о cookie и согласие на запись голоса", async ({ browser, browserName }) => {
  test.setTimeout(300_000);
  const context = await newContext(browser, "empty");
  const tape = await apiTape(context, `${browserName}-first`);
  const page = await context.newPage();
  await routes(page, SIZES[browserName], [["/", "first-home"], ["/sing/cn-earth", "first-sing"]], async () => {
    await expect(page.getByRole("region", { name: "Уведомление о cookie" })).toBeVisible();
  });
  tape.save();
  await context.close();
});

test("пение: проверка микрофона, пауза, итог, разбор, тренировка", async ({ browser, browserName }) => {
  test.setTimeout(300_000);
  const sizes = SIZES[browserName];
  const context = await newContext(browser, "no-consent");
  if (browserName === "chromium") await context.grantPermissions(["microphone"]);
  await fakeMic(context, "cn-earth", { shift: -3, errors: [[500, 610, 2]] });
  const tape = await apiTape(context, `${browserName}-sing`);
  const page = await context.newPage();
  await page.setViewportSize({ width: sizes[0][0], height: sizes[0][1] });
  await page.goto("/sing/cn-earth");
  await expect(page.getByRole("button", { name: "Без точной оценки" })).toBeVisible();
  await resized(page, sizes, "sing-consent");
  await page.getByRole("button", { name: "Без точной оценки" }).click();
  const go = page.getByRole("button", { name: /Начать пение/ });
  await expect(go).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Голос слышен" })).toBeVisible();
  // Индикатор уровня и линия голоса идут в реальном времени.
  await resized(page, sizes, "sing-mic-ready", () => [page.locator(".device")]);
  await page.setViewportSize({ width: sizes[0][0], height: sizes[0][1] });
  await go.click();
  // Пауза во время отсчёта: строки песни ещё не начались, время 0:00.
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect(page.getByText("Пауза", { exact: true })).toBeVisible();
  await resized(page, sizes, "sing-paused", () => [page.locator(".stage .screen")]);
  await page.setViewportSize({ width: sizes[0][0], height: sizes[0][1] });
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
  await expect(page.getByLabel(/из 100/)).toBeVisible();
  await page.waitForTimeout(1500);
  for (let i = 0; i < 8 && (await page.getByRole("button", { name: "Закрыть достижение" }).count()); i++) await page.getByRole("button", { name: "Закрыть достижение" }).first().click();
  const scoreMask = () => [".score-card .seal", ".verdict", ".companion", ".metrics dl", ".metrics .shift"].map((s) => page.locator(s));
  await resized(page, sizes, "result", scoreMask);
  await page.getByRole("button", { name: "Разбор и ошибки" }).click();
  await resized(page, sizes, "result-analysis", () => [page.locator("#analysis .trace"), page.locator("#analysis .analysis-title .cat"), page.locator("#analysis .moments")]);
  await page.getByRole("button", { name: "Потренировать" }).first().click();
  await expect(page.getByText("Тренировка без оценки")).toBeVisible();
  await resized(page, sizes, "practice");
  tape.save();
  await context.close();
});

const UUID = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const songFile = (name: string) => readFileSync(new URL(`../../static/songs/cn-earth/${name}`, import.meta.url));

/** Свой трек на заглушках (как tracks-lyrics.spec.ts): список «Мои треки» и редактор текста. */
async function mockTrack(page: Page) {
  const lines = [
    [["первая", 1, 1.6], ["строка", 1.6, 2.2], ["песни", 2.2, 3]],
    [["вторая", 4, 4.6], ["строка", 4.6, 5]],
    [["третья", 7, 7.6], ["строка", 7.6, 8.4]],
  ].map((l) => l.map(([text, start_s, end_s]) => ({ text: text as string, start_s: start_s as number, end_s: end_s as number })));
  const base = JSON.parse(songFile("reference.json").toString("utf8"));
  const reference = {
    ...base,
    id: `my-${UUID}`,
    title: "Моя песня",
    lyrics: lines.map((l) => ({ t: l[0].start_s, text: l.map((w) => w.text).join(" ") })),
    phrases: lines.map((l) => ({ start_s: l[0].start_s, end_s: l[l.length - 1].end_s })),
  };
  const words = { v: 1, lines: lines.map((l, i) => ({ line: i, words: l })) };
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ status: 404, json: { error: "Трек не найден." } });
    if (path === "/api/tracks") {
      const expiresAt = new Date(FIXED.getTime() + 20 * 3_600_000).toISOString();
      return route.fulfill({ json: { tracks: [{ id: UUID, title: "Моя песня", language: "ru", status: "ready", stage: null, error: null, expiresAt }] } });
    }
    const file = new RegExp(`^/api/tracks/${UUID}/files/(.+)$`).exec(path);
    if (file?.[1] === "reference.json") return route.fulfill({ json: reference });
    if (file?.[1] === "lyrics.words.json") return route.fulfill({ json: words });
    if (file) return route.fulfill({ body: songFile("backing.mp3"), contentType: "audio/mpeg" });
    return route.fulfill({ status: 404, json: { error: "Трек не найден." } });
  });
}

test("кабинет: страницы, поиск соперника, комната, свои треки и редактор текста", async ({ browser, browserName }) => {
  test.setTimeout(600_000);
  const sizes = SIZES[browserName];
  const context = await newContext(browser, "accepted");
  const tape = await apiTape(context, `${browserName}-member`);
  const page = await context.newPage();
  await page.goto("/");
  const status = await page.evaluate(async (password) => {
    const email = `pixels-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-perepev-request": "1" },
      body: JSON.stringify({ email, name: "Кот Пиксель", password, consent: true, ageGroup: "14plus" }),
    });
    return res.status;
  }, password);
  expect(status, "регистрация").toBe(201);
  await routes(page, sizes, [["/", "member-home"], ["/account", "member-account"], ["/friends", "member-friends"], ["/progress", "member-progress"], ["/leaders", "member-leaders"], ["/duels", "member-duels"]]);

  // Поиск соперника: карточка поиска сразу после начала (часы остановлены — «0:00»).
  await page.setViewportSize({ width: sizes[0][0], height: sizes[0][1] });
  await page.goto("/duels");
  const find = page.getByRole("button", { name: "Найти соперника" });
  await expect(find).toBeEnabled();
  await find.click();
  await expect(page.getByRole("button", { name: "Отменить поиск" })).toBeVisible();
  // Пояснение сервера («ждём первого, кто начнёт») приходит по WebSocket чуть позже: без ожидания
  // высота карточки зависела от того, успело ли оно прийти (1225 или 1251 px на 1024×768).
  await expect(page.locator(".search .why")).toBeVisible({ timeout: 15_000 }).catch(() => {});
  await resized(page, sizes, "member-duels-search");
  await page.getByRole("button", { name: "Отменить поиск" }).click();
  await expect(find).toBeEnabled();

  // Комната с другом: код комнаты случайный — под маской.
  await page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(page).toHaveURL(/\/duels\/match\//, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Скопировать ссылку" })).toBeVisible();
  await resized(page, sizes, "member-duels-room", () => [page.locator(".code")]);
  await page.getByRole("button", { name: /Выйти из комнаты/ }).click();
  await expect(page).toHaveURL(/\/duels$/, { timeout: 15_000 });

  // Свои треки (заглушка API) и редактор текста.
  await mockTrack(page);
  await routes(page, sizes, [["/songs", "member-songs"], [`/tracks/${UUID}/lyrics`, "member-lyrics"]], async (route) => {
    if (route === "/songs") await expect(page.getByRole("region", { name: "Мои треки" })).toBeVisible();
    else await expect(page.getByRole("heading", { name: "Текст и тайминги" })).toBeVisible();
  });
  tape.save();
  await context.close();
});
