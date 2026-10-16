// Точная оценка в интерфейсе (контракт C3) на заглушках /api/perf: режимы звука, согласие на запись,
// отправка голоса кусками 16 кГц во время пения и переход «предварительно» → окончательный балл.
// Отдельные дорожки песни подменяются копиями backing.mp3, а в index.json у песни ставится stems: true.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";
import { documents } from "../../src/lib/legal/operator";

const SONG = "cn-earth";
const reference = JSON.parse(readFileSync(new URL(`../../static/songs/${SONG}/reference.json`, import.meta.url), "utf8")) as { duration_s: number };
const backing = readFileSync(new URL(`../../static/songs/${SONG}/backing.mp3`, import.meta.url));

type Answer = { status: string; result: unknown };

/** Итог сервера: поля ScoreResult плюс проверка слов. */
const precise = (score: number, extra: Record<string, unknown> = {}) => ({
  score,
  rawScore: score,
  axes: { intervals: 0.51, rhythm: 0.62, stability: 0.73, coverage: 0.84 },
  lag: 0,
  shift: 0,
  registerShift: 0,
  shiftCurve: [],
  errors: [],
  seconds: [],
  phrases: [],
  moments: [],
  noteOffsets: [],
  constantTone: false,
  algorithm: "precise-1",
  wordsChecked: true,
  wordsSung: 0.82,
  wordsScore: 0.77,
  cap: null,
  ...extra,
});

/** Песня с отдельными дорожками: минус и голос-подсказка — копии backing.mp3. */
async function stems(page: Page) {
  const requested: string[] = [];
  page.on("request", (r) => {
    const m = /\/songs\/cn-earth\/([^/?]+\.mp3)$/.exec(r.url());
    if (m) requested.push(m[1]);
  });
  await page.route("**/songs/index.json", async (route) => {
    const response = await route.fetch();
    const list = (await response.json()) as { id: string; stems?: boolean }[];
    for (const song of list) if (song.id === SONG) song.stems = true;
    await route.fulfill({ response, json: list });
  });
  await page.route(/\/songs\/cn-earth\/(instrumental|guide)\.mp3$/, (route) => route.fulfill({ body: backing, contentType: "audio/mpeg" }));
  return requested;
}

/** Заглушка /api/perf: запоминает запросы и отвечает на опрос по сценарию. */
async function perf(page: Page, answer: () => Answer) {
  const log = { created: [] as unknown[], chunks: [] as { seq: number; bytes: number; peak: number }[], finished: [] as unknown[], polls: 0 };
  await page.route(/\/api\/perf(\/|\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/perf") {
      log.created.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { id: "perf-1" } });
    }
    if (request.method() === "PUT" && url.pathname === "/api/perf/perf-1/chunk") {
      expect(request.headers()["x-perepev-request"]).toBe("1");
      const pcm = new Int16Array(new Uint8Array(request.postDataBuffer()!).buffer);
      log.chunks.push({ seq: Number(url.searchParams.get("seq")), bytes: pcm.byteLength, peak: pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0) });
      return route.fulfill({ status: 204 });
    }
    if (request.method() === "POST" && url.pathname === "/api/perf/perf-1/finish") {
      log.finished.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: {} });
    }
    if (request.method() === "GET" && url.pathname === "/api/perf/perf-1") {
      log.polls++;
      return route.fulfill({ json: answer() });
    }
    return route.fulfill({ status: 404, json: { error: "Нет такой записи." } });
  });
  return log;
}

/** Какие дорожки запустились и с каким эхоподавлением открыт микрофон. Ставится после fakeMic. */
async function spy(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __spy: { started: number[]; echo: unknown[] } };
    w.__spy = { started: [], echo: [] };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: number[]) {
      if (this.buffer) w.__spy.started.push(this.buffer.duration);
      return (start as (...a: number[]) => void).apply(this, args);
    } as typeof start;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      w.__spy.echo.push((constraints?.audio as MediaTrackConstraints | undefined)?.echoCancellation);
      return getUserMedia(constraints);
    };
  });
}

const songTracks = (page: Page) =>
  page.evaluate((duration) => (window as unknown as { __spy: { started: number[] } }).__spy.started.filter((d) => Math.abs(d - duration) < 0.3).length, reference.duration_s);

async function sing(page: Page, mode: "headphones" | "speaker" = "headphones") {
  await page.goto(`/sing/${SONG}`);
  if (mode === "speaker") await page.getByRole("button", { name: "Без наушников" }).click();
  // Совет в списке проверок зависит от режима: «Надень наушники» только в режиме «В наушниках».
  const tip = page.locator(".checklist li.tip");
  if (mode === "speaker") await expect(tip).not.toContainText("Надень наушники");
  else await expect(tip).toContainText("Надень наушники: без них голос исполнителя попадёт в запись. Подпевай");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
}

const summary = (page: Page) => page.getByRole("region", { name: "Итог" });
const shownScore = async (page: Page) => Number((await page.getByLabel(/из 100/).getAttribute("aria-label"))!.split(" ")[0]);
const lastAttempt = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem("perepev.guestAttempts") ?? "[]") as { score: number; wordsChecked?: boolean }[])[0]);

test("в наушниках: минус и подсказка, голос уходит кусками 16 кГц, «предварительно» → окончательный балл", async ({ page, context }) => {
  await fakeMic(context, SONG, { shift: -2 });
  await spy(context);
  const requested = await stems(page);
  let ready = false;
  const log = await perf(page, () => (ready ? { status: "done", result: precise(42.4) } : { status: "running", result: null }));
  await sing(page);

  await expect(page.getByText("предварительно", { exact: true })).toBeVisible();
  expect(await shownScore(page)).toBeGreaterThan(70);
  await expect(summary(page).getByText("Ритм", { exact: true })).toBeVisible();
  ready = true;
  await expect(page.getByLabel("42.4 из 100")).toBeVisible();
  await expect(page.getByText("предварительно", { exact: true })).toHaveCount(0);
  await expect(page.getByText("слова проверены", { exact: true })).toBeVisible();
  await expect(summary(page).getByText("Ритм и слова", { exact: true })).toBeVisible();
  await expect.poll(() => lastAttempt(page)).toMatchObject({ score: 42.4, wordsChecked: true });

  expect(log.created).toEqual([{ songId: SONG, mode: "headphones", voiceConsent: true, consentVersion: documents.consent }]);
  // 16 кГц × 2 байта × 5 с = 160 000 байт на кусок; остаток уходит при завершении.
  const expected = Math.ceil(reference.duration_s / 5);
  expect(log.chunks.map((c) => c.seq)).toEqual([...Array(expected).keys()]);
  expect(log.chunks.slice(0, -1).every((c) => c.bytes === 160_000)).toBe(true);
  const total = log.chunks.reduce((n, c) => n + c.bytes, 0);
  expect(Math.abs(total - reference.duration_s * 16_000 * 2)).toBeLessThan(400);
  expect(Math.max(...log.chunks.map((c) => c.peak))).toBeGreaterThan(2000);
  expect(log.finished).toEqual([{ chunks: expected }]);

  expect(requested).toContain("instrumental.mp3");
  expect(requested).toContain("guide.mp3");
  expect(requested).not.toContain("backing.mp3");
  expect(await songTracks(page)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __spy: { echo: unknown[] } }).__spy.echo.at(-1))).toBe(false);
});

test("без наушников: только минус, эхоподавление, выбор запоминается; подсказка «Почти не слышно слов»", async ({ page, context }) => {
  await fakeMic(context, SONG);
  await spy(context);
  const requested = await stems(page);
  const log = await perf(page, () => ({ status: "done", result: precise(38, { cap: "words", wordsSung: 0.1, wordsScore: 0.05 }) }));
  await sing(page, "speaker");

  await expect(page.getByLabel("38.0 из 100")).toBeVisible();
  await expect(page.getByText("Почти не слышно слов")).toBeVisible();
  expect((log.created[0] as { mode: string }).mode).toBe("speaker");
  expect(requested).toContain("instrumental.mp3");
  expect(requested).not.toContain("guide.mp3");
  expect(requested).not.toContain("backing.mp3");
  expect(await songTracks(page)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __spy: { echo: unknown[] } }).__spy.echo.at(-1))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("perepev.playMode"))).toBe("speaker");

  await page.goto(`/sing/${SONG}`);
  await expect(page.getByRole("button", { name: "Без наушников" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "В наушниках" })).toHaveAttribute("aria-pressed", "false");
});

test("звук из динамика при молчании: балл ограничен и показана подсказка про наушники", async ({ page, context }) => {
  await fakeMic(context, SONG, { silent: true });
  await stems(page);
  await perf(page, () => ({ status: "done", result: precise(30, { cap: "bleed", wordsSung: 0.9 }) }));
  await sing(page);
  await expect(page.getByLabel("30.0 из 100")).toBeVisible();
  // «В наушниках» без наушников: надеть их или перейти в режим, где звучит только минус.
  await expect(page.getByText("Похоже, голос исполнителя звучал из динамика. Надень наушники или выбери режим «Без наушников»: тогда играет только минус.")).toBeVisible();
});

test("звук из динамика в режиме «Без наушников»: совет надеть наушники и выбрать «В наушниках»", async ({ page, context }) => {
  await fakeMic(context, SONG, { silent: true });
  await stems(page);
  await perf(page, () => ({ status: "done", result: precise(30, { cap: "bleed", wordsSung: 0.9 }) }));
  await sing(page, "speaker");
  await expect(page.getByLabel("30.0 из 100")).toBeVisible();
  await expect(page.getByText("Похоже, голос исполнителя из динамика попал в запись. Надень наушники и выбери режим «В наушниках».")).toBeVisible();
});

test("подсказка не загрузилась: звучит исходный микс, проверка микрофона проходит", async ({ page, context }) => {
  await fakeMic(context, SONG);
  const requested = await stems(page);
  await page.route(/\/songs\/cn-earth\/guide\.mp3$/, (route) => route.abort());
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requested).toContain("backing.mp3");
  // Подсказки режима — как у песни без отдельных дорожек.
  await expect(page.getByText("Звучит запись с голосом исполнителя.")).toBeVisible();
});

test("компьютер обработки выключен: браузерный балл становится окончательным, «слова не проверены»", async ({ page, context }) => {
  await fakeMic(context, SONG, { shift: 3 });
  await stems(page);
  await perf(page, () => ({ status: "offline", result: null }));
  await sing(page);
  await expect(page.getByText("слова не проверены", { exact: true })).toBeVisible();
  await expect(page.getByText("предварительно", { exact: true })).toHaveCount(0);
  await expect(summary(page).getByText("Ритм", { exact: true })).toBeVisible();
  const score = await shownScore(page);
  expect(score).toBeGreaterThan(70);
  await expect.poll(() => lastAttempt(page)).toMatchObject({ score, wordsChecked: false });
});

test("ответа нет 25 секунд (всё ещё running): результат завершается с пометкой «слова не проверены»", async ({ page, context }) => {
  await fakeMic(context, SONG);
  await stems(page);
  const log = await perf(page, () => ({ status: "running", result: null }));
  await sing(page);
  await expect(page.getByText("предварительно", { exact: true })).toBeVisible();
  const provisional = await shownScore(page);
  await expect(page.getByText("слова не проверены", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("предварительно", { exact: true })).toHaveCount(0);
  expect(await shownScore(page)).toBe(provisional);
  expect(log.polls).toBeGreaterThan(25);
  expect(log.polls).toBeLessThan(40);
  await expect.poll(() => lastAttempt(page)).toMatchObject({ score: provisional, wordsChecked: false });
});

test("согласие на запись голоса: одно нажатие перед первым микрофоном, заново при новой редакции; отказ не отправляет голос", async ({ browser }) => {
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:4173";
  // Согласие прежней редакции не считается.
  const context = await browser.newContext({
    permissions: ["microphone"],
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "perepev.cookies", value: "test" }, { name: "perepev.voiceConsent", value: "2026-10-16" }] }] },
  });
  await fakeMic(context, SONG);
  const page = await context.newPage();
  await stems(page);
  const log = await perf(page, () => ({ status: "offline", result: null }));
  await page.goto(`/sing/${SONG}`);

  const consent = page.getByRole("region", { name: "Точная оценка со словами" });
  await expect(consent).toBeVisible();
  await expect(consent.getByRole("link", { name: "Согласие на обработку данных" })).toHaveAttribute("href", "/legal/consent");
  // Обычной кнопки нет: микрофон включает только нажатие согласия или отказ.
  await expect(page.getByRole("button", { name: "Включить микрофон", exact: true })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Начать пение" })).toHaveCount(0);
  const tap = consent.getByRole("button", { name: "Согласен, включить микрофон" });
  expect((await tap.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await tap.click();
  await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
  await expect(consent).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("perepev.voiceConsent"))).toBe(documents.consent);

  // Второй раз согласие не спрашивается.
  await page.reload();
  await expect(page.getByRole("button", { name: "Включить микрофон", exact: true })).toBeVisible();
  await expect(consent).toHaveCount(0);

  // Отказ: петь можно, но голос не отправляется и согласие не запоминается.
  await page.evaluate(() => localStorage.removeItem("perepev.voiceConsent"));
  await page.reload();
  await consent.getByRole("button", { name: "Без точной оценки" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
  await page.waitForTimeout(2000);
  expect(log.created).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("perepev.voiceConsent"))).toBeNull();
  await context.close();
});
