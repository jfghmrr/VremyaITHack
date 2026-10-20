// Правка текста своего трека на заглушках /api/tracks: из «Моих треков» в редактор,
// исправление слов, сдвиг строки, начало по позиции звука, удаление лишней строки,
// сохранение (PUT /api/tracks/<id>/lyrics) и пение с исправленным текстом.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";

const UUID = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const songFile = (name: string) => readFileSync(new URL(`../../static/songs/cn-earth/${name}`, import.meta.url));
const profile = { id: "00000000-0000-4000-8000-000000000003", name: "Певец-4321", email: null, hasPassword: false, providers: ["vk"] };

type Word = { text: string; start_s: number; end_s: number };
const line = (...words: [string, number, number][]) => words.map(([text, start_s, end_s]) => ({ text, start_s, end_s }));
/** Свои слова поверх мелодии cn-earth: текст песни каталога не используется. */
const recognised: Word[][] = [
  line(["первая", 1, 1.6], ["строка", 1.6, 2.2], ["песни", 2.2, 3]),
  line(["вторая", 4, 4.6], ["строка", 4.6, 5]),
  line(["третья", 7, 7.6], ["строка", 7.6, 8.4]),
  line(["Продолжение", 11, 11.8], ["следует", 11.8, 12.6]),
];

function files(lines: Word[][]) {
  const base = JSON.parse(songFile("reference.json").toString("utf8"));
  const reference = {
    ...base,
    id: `my-${UUID}`,
    title: "Моя песня",
    lyrics: lines.map((l) => ({ t: l[0].start_s, text: l.map((w) => w.text).join(" ") })),
    phrases: lines.map((l) => ({ start_s: l[0].start_s, end_s: l[l.length - 1].end_s })),
  };
  const words = { v: 1, lines: lines.map((l, i) => ({ line: i, words: l })) };
  return { reference, words };
}

async function mockTrack(page: Page) {
  const log = { saved: [] as { lines: { words: Word[] }[] }[] };
  let current = recognised;
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/tracks") {
      const expiresAt = new Date(Date.now() + 20 * 3_600_000).toISOString();
      return route.fulfill({ json: { tracks: [{ id: UUID, title: "Моя песня", language: "ru", status: "ready", stage: null, error: null, expiresAt }] } });
    }
    if (method === "PUT" && path === `/api/tracks/${UUID}/lyrics`) {
      expect(request.headers()["x-perepev-request"]).toBe("1");
      const body = request.postDataJSON();
      log.saved.push(body);
      current = body.lines.map((l: { words: Word[] }) => l.words);
      return route.fulfill({ json: { lines: files(current).words.lines, masked: 0 } });
    }
    const file = new RegExp(`^/api/tracks/${UUID}/files/(.+)$`).exec(path);
    if (method === "GET" && file) {
      const { reference, words } = files(current);
      if (file[1] === "reference.json") return route.fulfill({ json: reference });
      if (file[1] === "lyrics.words.json") return route.fulfill({ json: words });
      return route.fulfill({ body: songFile("backing.mp3"), contentType: "audio/mpeg" });
    }
    return route.fulfill({ status: 404, json: { error: "Трек не найден." } });
  });
  return log;
}

const card = (page: Page, n: number) => page.locator("ol.lines > li").nth(n - 1);

test("свой трек: правка текста и таймингов, сохранение и пение с новым текстом", async ({ page, context, browserName }) => {
  await fakeMic(context, "cn-earth");
  const log = await mockTrack(page);
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  await mine.getByRole("link", { name: "Править текст «Моя песня»" }).click();
  await expect(page).toHaveURL(new RegExp(`/tracks/${UUID}/lyrics$`));
  await expect(page.getByRole("heading", { name: "Текст и тайминги" })).toBeVisible();
  await expect(page.getByText("Моя песня", { exact: true })).toBeVisible();
  await expect(page.locator("ol.lines > li")).toHaveCount(4);
  await expect(page.getByLabel("Строка 1", { exact: true })).toHaveValue("первая строка песни");

  // Слово исправляется в строке; время соседних слов сохраняется.
  await page.getByLabel("Строка 1", { exact: true }).fill("первая строчка песни");
  await page.getByLabel("Строка 1", { exact: true }).press("Enter");
  await expect(card(page, 1).locator(".words")).toHaveText("первая строчка песни");
  await expect(card(page, 1).locator(".range")).toHaveText("0:01,0–0:03,0");

  // Сдвиг строки кнопкой и начало строки по позиции звука (на паузе — точно).
  await page.getByRole("button", { name: "Строку 2 позже на 0,1 с" }).click();
  await expect(card(page, 2).locator(".range")).toHaveText("0:04,1–0:05,1");
  await page.getByLabel("Позиция").evaluate((input: HTMLInputElement) => {
    input.value = "6";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".clock")).toContainText("0:06,0");
  await page.getByRole("button", { name: "Начало строки 3 здесь" }).click();
  await expect(card(page, 3).locator(".range")).toHaveText("0:06,0–0:07,4");

  // Пустую строку сохранить нельзя: подсказка без запроса к серверу.
  await page.getByLabel("Строка 4", { exact: true }).fill("");
  await page.getByLabel("Строка 4", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("alert")).toContainText("Строка 4 пустая");
  expect(log.saved).toHaveLength(0);
  await page.getByRole("button", { name: "Удалить строку 4" }).click();
  await expect(page.locator("ol.lines > li")).toHaveCount(3);

  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Сохранено." })).toBeVisible();
  expect(log.saved).toHaveLength(1);
  await page.screenshot({ path: "test-results/tracks-lyrics-desktop.png" });
  const saved = log.saved[0].lines;
  expect(saved.map((l) => l.words.map((w) => w.text).join(" "))).toEqual(["первая строчка песни", "вторая строка", "третья строка"]);
  expect(saved[0].words[0]).toEqual({ text: "первая", start_s: 1, end_s: 1.6 });
  expect(saved[1].words[0].start_s).toBe(4.1);
  expect(saved[2].words[0].start_s).toBe(6);
  const all = saved.flatMap((l) => l.words);
  all.forEach((w, i) => {
    expect(w.end_s).toBeGreaterThan(w.start_s);
    if (i) expect(w.start_s).toBeGreaterThanOrEqual(all[i - 1].end_s);
  });

  // Пение после правки показывает исправленный текст.
  await page.getByRole("status").getByRole("link", { name: "Петь" }).click();
  await expect(page).toHaveURL(new RegExp(`/sing/my-${UUID}$`));
  // В проекте WebKit проверяется сам редактор; пение с синтетическим микрофоном — в Chromium.
  if (browserName === "webkit") return;
  await page.getByRole("button", { name: "Включить микрофон", exact: true }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  const book = page.getByLabel("Пение").locator("ol.lines");
  await expect(book).toContainText("первая строчка песни");
  await expect(book).toContainText("третья строка");
  await expect(book).not.toContainText("Продолжение");
  await page.goto("/songs");
});

test("редактор текста на телефоне: кнопки не меньше 44 px, без горизонтальной прокрутки", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("perepev.cookies", "test"));
  await mockTrack(page);
  await page.goto(`/tracks/${UUID}/lyrics`);
  await expect(page.getByLabel("Строка 1", { exact: true })).toHaveValue("первая строка песни");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.locator(".editor button, .editor .btn, .editor input").evaluateAll((nodes) =>
    nodes
      .filter((n) => (n as HTMLElement).offsetParent !== null && (n as HTMLInputElement).type !== "range")
      .map((n) => ({ text: (n.getAttribute("aria-label") ?? n.textContent ?? "").trim(), h: n.getBoundingClientRect().height }))
      .filter((b) => b.h < 44 - 0.5), // полпикселя на округление, как в responsive.spec
  );
  expect(small).toEqual([]);
  await page.screenshot({ path: "test-results/tracks-lyrics-phone.png", fullPage: true });
  await context.close();
});
