// Правки владельца для одиночного пения (17.10.2026):
// P16 — третья клавиша «Начать заново» на сцене: та же песня с начала без проверки микрофона,
//        прежняя отправка голоса на точную оценку отменяется, новая начинается заново;
// P9  — подсказки клавиш на проверке микрофона не налезают на кнопки согласия;
// P11 — «Поделиться»: карточка ссылки у кнопки, кнопки попытки не сдвигаются и не закрываются,
//        Esc закрывает карточку, а не уходит со страницы.
import { expect, test, type Page } from "@playwright/test";
import { fakeMic } from "./fake-mic";

const SONG = "cn-earth";

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

/** Заглушка /api/perf с номером на каждую запись: какие куски и завершения пришли и для какой записи. */
async function perfStub(page: Page) {
  const log = { created: [] as string[], events: [] as string[] };
  await page.route(/\/api\/perf(\/|\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/perf") {
      const id = `perf-${log.created.length + 1}`;
      log.created.push(id);
      log.events.push(`create ${id}`);
      return route.fulfill({ status: 201, json: { id } });
    }
    const m = /^\/api\/perf\/([^/]+)\/(chunk|finish)$/.exec(url.pathname);
    if (m) {
      log.events.push(`${m[2]} ${m[1]}`);
      return route.fulfill(m[2] === "chunk" ? { status: 204 } : { status: 202, json: {} });
    }
    if (request.method() === "GET") return route.fulfill({ json: { status: "running", result: null } });
    return route.fulfill({ status: 404, json: { error: "Нет такой записи." } });
  });
  return log;
}

test("P16: «Начать заново» перезапускает песню без проверки микрофона, старая отправка голоса отменена", async ({ page, context }) => {
  test.setTimeout(150_000);
  await fakeMic(context, SONG, { shift: -2 });
  const log = await perfStub(page);
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  const stage = page.getByLabel("Пение", { exact: true });
  await expect(stage).toBeVisible();
  const restart = page.getByRole("button", { name: "Начать заново" });
  await expect(restart).toBeVisible();
  // Песня идёт: часы ушли дальше 0:06, первый 5-секундный кусок отправлен.
  await expect(stage.locator(".time")).toContainText(/^0:0[6-9]/, { timeout: 15_000 });
  await expect.poll(() => log.events.filter((e) => e === "chunk perf-1").length).toBeGreaterThan(0);
  await restart.click();
  // Снова отсчёт и 0:00, проверки микрофона нет, микрофон не переоткрывался.
  await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toHaveCount(0);
  await expect(stage.locator(".countdown")).toBeVisible();
  await expect(stage.locator(".time")).toContainText(/^0:00/);
  await expect.poll(() => log.created).toEqual(["perf-1", "perf-2"]);
  const cut = log.events.indexOf("create perf-2");
  // Песня доходит до конца: результат считается по новой попытке.
  await expect(page).toHaveURL(/\/result$/, { timeout: 60_000 });
  const after = log.events.slice(cut + 1);
  expect(after.filter((e) => e.endsWith("perf-1")), "после рестарта прежняя запись не досылается").toEqual([]);
  expect(after).toContain("finish perf-2");
  expect(log.events).not.toContain("finish perf-1");
  // Новая попытка целая: балл как у чистого исполнения синтетического певца.
  const score = Number((await page.getByLabel(/из 100/).getAttribute("aria-label"))!.split(" ")[0]);
  expect(score).toBeGreaterThan(70);
});

test("P16: клавиша R на сцене тоже начинает заново", async ({ page, context }) => {
  await fakeMic(context, SONG, {});
  await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  const stage = page.getByLabel("Пение", { exact: true });
  await expect(stage.locator(".time")).toContainText(/^0:0[3-9]/, { timeout: 15_000 });
  await page.keyboard.press("r");
  await expect(stage.locator(".countdown")).toBeVisible();
  await expect(stage.locator(".time")).toContainText(/^0:00/);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").getByRole("button", { name: /^Выйти/ }).click();
  await expect(page).toHaveURL(/\/songs$/);
});

test("P16: заново во время отсчёта, на паузе и сразу после Пробела — песня идёт, без «Пауза»", async ({ page, context }) => {
  test.setTimeout(120_000);
  await fakeMic(context, SONG, {});
  // Приостановка контекста срабатывает сразу, а её обещание выполняется с задержкой:
  // так «Пробел и сразу R» надёжно ловит гонку setPause(true) с перезапуском.
  await context.addInitScript(() => {
    const suspend = AudioContext.prototype.suspend;
    AudioContext.prototype.suspend = async function (this: AudioContext) {
      await suspend.call(this);
      await new Promise((r) => setTimeout(r, 600));
    };
  });
  await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  const stage = page.getByLabel("Пение", { exact: true });
  const time = stage.locator(".time");
  const pausedOverlay = stage.getByText("Пауза", { exact: true });
  const running = async (what: string) => {
    await expect(stage.locator(".countdown"), `${what}: отсчёт`).toBeVisible();
    await expect(time, `${what}: песня с начала и идёт`).toContainText(/^0:0[2-9]/, { timeout: 10_000 });
    await expect(pausedOverlay, `${what}: нет «Пауза»`).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Пауза", exact: true }), `${what}: клавиша паузы не нажата`).toHaveAttribute("aria-pressed", "false");
  };
  // 1. Во время отсчёта.
  await expect(stage.locator(".countdown")).toBeVisible();
  await page.keyboard.press("r");
  await running("рестарт во время отсчёта");
  // 2. На паузе.
  await page.keyboard.press("Space");
  await expect(pausedOverlay).toBeVisible();
  await page.getByRole("button", { name: "Начать заново" }).click();
  await running("рестарт на паузе");
  // 3. Пробел и сразу R: отложенная пауза не ложится поверх новой попытки.
  await page.keyboard.press("Space");
  await page.keyboard.press("r");
  await page.waitForTimeout(1200);
  await running("Пробел и сразу R");
});

test("фрагмент песни с проверки микрофона замолкает, когда начинается пение", async ({ page, context }) => {
  await fakeMic(context, SONG, {});
  await context.addInitScript(() => {
    // Подключение микрофона идёт долго: фрагмент можно включить, пока кнопка ещё «Подключаем…»,
    // и он доигрывает после enableMic() — именно этот случай start() должен остановить.
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 800));
      return gum(c);
    };
    const NativeAudio = window.Audio;
    const made: HTMLAudioElement[] = [];
    (window as unknown as { __audios: HTMLAudioElement[] }).__audios = made;
    window.Audio = function (this: unknown, ...args: ConstructorParameters<typeof Audio>) {
      const a = new NativeAudio(...args);
      made.push(a);
      return a;
    } as unknown as typeof Audio;
  });
  await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: /Послушать/ }).click();
  const playing = () => page.evaluate(() => (window as unknown as { __audios: HTMLAudioElement[] }).__audios.filter((a) => !a.paused).length);
  await expect.poll(playing).toBe(1);
  const go = page.getByRole("button", { name: "Начать пение" });
  await expect(go).toBeVisible({ timeout: 10_000 });
  // Фрагмент ещё звучит на готовой проверке: пение его останавливает.
  expect(await playing()).toBe(1);
  await go.click();
  await expect(page.getByLabel("Пение", { exact: true }).locator(".countdown")).toBeVisible();
  await expect.poll(playing).toBe(0);
});

test("подсказки клавиш на сцене: в окне с мышью показаны, пока есть место; клавиши 52×52, время в одну строку", async ({ page, context }) => {
  test.setTimeout(90_000);
  await fakeMic(context, SONG, {});
  await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  const stage = page.getByLabel("Пение", { exact: true });
  await expect(stage).toBeVisible();
  const sizes = [
    { w: 1366, h: 768, hint: true }, // wide
    { w: 800, h: 1000, hint: true }, // узкое окно, портрет: ряд плеера на всю ширину
    { w: 1000, h: 500, hint: false }, // низкое окно: плеер в правой колонке, места нет
    { w: 360, h: 740, hint: false }, // узкое окно: места нет
  ];
  for (const s of sizes) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.waitForTimeout(150);
    const row = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const time = document.querySelector(".stage .time")!;
      const range = document.createRange();
      range.selectNodeContents(time);
      const hint = document.querySelector(".stage .hint")!;
      const others = [time, ...document.querySelectorAll(".stage .round")].map(box);
      const h = box(hint);
      return {
        hintShown: getComputedStyle(hint).display !== "none",
        timeLines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
        keys: [...document.querySelectorAll(".stage .round")].map((k) => [Math.round(k.getBoundingClientRect().width), Math.round(k.getBoundingClientRect().height)]),
        overlap: getComputedStyle(hint).display !== "none" && others.some((o) => Math.min(o.right, h.right) - Math.max(o.left, h.left) > 1),
        hintClipped: hint.scrollWidth > hint.clientWidth + 1,
      };
    });
    const at = `${s.w}×${s.h}`;
    expect(row.hintShown, `${at}: подсказки клавиш ${s.hint ? "видны" : "скрыты"}`).toBe(s.hint);
    expect(row.keys, `${at}: клавиши плеера 52×52`).toEqual([[52, 52], [52, 52], [52, 52]]);
    expect(row.timeLines, `${at}: время в одну строку`).toBe(1);
    expect(row.overlap, `${at}: подсказки не налезают на время и клавиши`).toBe(false);
    expect(row.hintClipped, `${at}: текст подсказок не обрезан`).toBe(false);
  }
});

for (const s of [
  { w: 1366, h: 768 },
  { w: 1280, h: 720 },
  { w: 1536, h: 730 },
  { w: 1280, h: 600 },
]) {
  test(`P9: ${s.w}×${s.h} — подсказки клавиш не под кнопками согласия на проверке микрофона`, async ({ browser }) => {
    // Новый посетитель: согласие на запись ещё не дано, карточка согласия на экране.
    const context = await browser.newContext({ viewport: { width: s.w, height: s.h }, storageState: { cookies: [], origins: [{ origin: process.env.BASE_URL ?? "http://127.0.0.1:4173", localStorage: [{ name: "perepev.cookies", value: "test" }] }] } });
    const page = await context.newPage();
    await page.goto(`/sing/${SONG}`);
    const accept = page.getByRole("button", { name: /Согласен/ });
    await expect(accept).toBeVisible();
    const keys = (await page.locator(".keys").boundingBox())!;
    for (const name of [/Согласен/, /Без точной оценки/]) {
      const b = (await page.getByRole("button", { name }).boundingBox())!;
      expect(overlaps(keys, b), `${s.w}×${s.h}: подсказки клавиш × «${name.source}»`).toBe(false);
      expect(keys.y, `${s.w}×${s.h}: подсказки под кнопками`).toBeGreaterThanOrEqual(b.y + b.height);
    }
    await page.screenshot({ path: `test-results/solo/mic-consent-${s.w}x${s.h}.png`, fullPage: true });
    await context.close();
  });
}

test("P11: «Поделиться» — карточка ссылки у кнопки, кнопки попытки на месте, Esc закрывает карточку", async ({ page, context }) => {
  test.setTimeout(120_000);
  await fakeMic(context, SONG, {});
  await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 60_000 });
  await expect(page.getByLabel(/из 100/)).toBeVisible();
  const controls = ["Слушать попытку", "Как пел", "Ещё раз"] as const;
  const locate = (name: string) => (name === "Ещё раз" ? page.getByRole("link", { name: /Ещё раз/ }) : page.getByRole("button", { name, exact: true }));
  const before = await Promise.all(controls.map(async (c) => (await locate(c).boundingBox())!));

  await page.getByRole("button", { name: "Поделиться" }).click();
  const card = page.getByRole("dialog", { name: "Ссылка-вызов" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Ссылка скопирована")).toBeVisible();
  const link = await card.getByRole("textbox", { name: "Ссылка-вызов" }).inputValue();
  expect(link).toMatch(/\/#echo=[-_A-Za-z0-9]+$/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  // Гость задаёт имя в карточке: ссылка пересобирается и копируется заново.
  await card.getByLabel("Имя для вызова").fill("Саша");
  await expect(card.getByText("Ссылка обновлена и скопирована")).toBeVisible();
  expect(await card.getByRole("textbox", { name: "Ссылка-вызов" }).inputValue()).not.toBe(link);

  // Кнопки попытки не сдвинулись и не закрыты карточкой.
  const box = (await card.boundingBox())!;
  for (const [i, c] of controls.entries()) {
    const now = (await locate(c).boundingBox())!;
    expect(now, `«${c}» на прежнем месте`).toEqual(before[i]);
    expect(overlaps(box, now), `карточка закрывает «${c}»`).toBe(false);
  }
  await page.screenshot({ path: "test-results/solo/share-open-1366.png" });

  // Esc закрывает карточку и оставляет на странице результата.
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(page).toHaveURL(/\/result$/);
  // Повторно — и закрыть крестиком; щелчок мимо тоже закрывает.
  await page.getByRole("button", { name: "Поделиться" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Закрыть" }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Поделиться" }).click();
  await expect(card).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(card).toHaveCount(0);
});

test.describe("P11 на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("«Поделиться»: лист снизу экрана во всю ширину, копирование по нажатию (как в iOS), закрывается крестиком", async ({ page, context }) => {
    test.setTimeout(120_000);
    await fakeMic(context, SONG, {});
    // Буфер обмена как в iOS Safari: запись разрешена только синхронно внутри нажатия.
    await context.addInitScript(() => {
      let gesture = false;
      addEventListener("click", () => (gesture = true), true);
      addEventListener("click", () => (gesture = false));
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            if (!gesture) return Promise.reject(new DOMException("Нет жеста", "NotAllowedError"));
            w.__copied.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
    await page.goto(`/sing/${SONG}`);
    await page.getByRole("button", { name: "Включить микрофон" }).click();
    await page.getByRole("button", { name: "Начать пение" }).click();
    await expect(page).toHaveURL(/\/result$/, { timeout: 60_000 });
    const share = page.getByRole("button", { name: "Поделиться" });
    await share.scrollIntoViewIfNeeded();
    await share.click();
    const card = page.getByRole("dialog", { name: "Ссылка-вызов" });
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.width).toBeGreaterThan(350);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    // Ссылка готова, фокус в поле ссылки; копирование без нажатия не прошло — без ошибки.
    const field = card.getByRole("textbox", { name: "Ссылка-вызов" });
    await expect(card.getByText("Ссылка готова — нажми «Скопировать»")).toBeVisible();
    await expect(field).toBeFocused();
    const link = await field.inputValue();
    expect(link).toMatch(/\/#echo=[-_A-Za-z0-9]+$/);
    await card.getByRole("button", { name: "Скопировать" }).click();
    await expect(card.getByText("Ссылка скопирована")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([link]);
    // Смена имени гостя: ссылка пересобрана, фокус остаётся в поле имени.
    const nameField = card.getByLabel("Имя для вызова");
    await nameField.fill("Саша");
    await expect(card.getByText("Ссылка обновлена — нажми «Скопировать»")).toBeVisible();
    await expect(nameField).toBeFocused();
    await page.screenshot({ path: "test-results/solo/share-sheet-390.png" });
    // Низкий ландшафт: лист не выше окна и прокручивается внутри.
    await page.setViewportSize({ width: 844, height: 390 });
    const wide = (await card.boundingBox())!;
    expect(wide.y).toBeGreaterThanOrEqual(0);
    expect(wide.y + wide.height).toBeLessThanOrEqual(390);
    await card.getByRole("button", { name: "Скопировать" }).scrollIntoViewIfNeeded();
    await expect(card.getByRole("button", { name: "Скопировать" })).toBeInViewport();
    await page.screenshot({ path: "test-results/solo/share-sheet-844x390.png" });
    await card.getByRole("button", { name: "Закрыть" }).click();
    await expect(card).toHaveCount(0);
  });
});

// Ревью: на телефоне «Итог | Разбор и ошибки» прячет раздел с нажатой кнопкой, и фокус падал
// на <body>. Фокус переходит на ту же кнопку в открывшемся разделе (клавиатура, экранный диктор).
test.describe("результат на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("«Итог | Разбор и ошибки»: фокус остаётся на нажатой кнопке в открывшемся разделе", async ({ page, context }) => {
    test.setTimeout(120_000);
    await fakeMic(context, SONG, {});
    await page.route(/\/api\/perf(\/|\?|$)/, (route) => route.fulfill({ status: 503, json: { error: "Нет обработчика." } }));
    await page.goto(`/sing/${SONG}`);
    await page.getByRole("button", { name: "Включить микрофон" }).click();
    await page.getByRole("button", { name: "Начать пение" }).click();
    await expect(page).toHaveURL(/\/result$/, { timeout: 60_000 });
    const focused = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return { text: a?.textContent?.trim(), section: a?.closest("section")?.getAttribute("aria-label") ?? null, pressed: a?.getAttribute("aria-pressed") ?? null };
      });
    await page.getByRole("button", { name: "Разбор и ошибки" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Разбор" })).toBeVisible();
    expect(await focused()).toEqual({ text: "Разбор и ошибки", section: "Разбор", pressed: "true" });
    await page.getByRole("button", { name: "Итог", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Итог" })).toBeVisible();
    expect(await focused()).toEqual({ text: "Итог", section: "Итог", pressed: "true" });
  });
});
