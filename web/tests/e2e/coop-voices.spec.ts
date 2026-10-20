// «Вместе», настоящие голоса от начала до конца: оба согласились → обе записи приняты сервером
// (204) → на обоих итогах по умолчанию звучат настоящие голоса (минус и обе записи на одном
// AudioContext). Плюс: итог открыт заново, своя запись не сохранилась («Отправить ещё раз»),
// снятие согласия убирает повтор, «Согласны оба…» следует за своей галочкой. Гонки передачи
// синтеза настоящим голосам — coop-handover.spec.ts.
// Компьютер и телефон: в проекте WebKit партнёр — отдельный WebKit с эмуляцией iPhone (две
// страницы в одном WebKit делят звук: страница сзади пишет тишину, это свойство стенда).
import { expect, test, webkit } from "@playwright/test";
import { shots, iphone, phone, VOICE_PUT, sharedRoom, sing, noSideScroll, real, hearsRealVoices } from "./coop-voice-bench";

test("согласились оба: записи приняты, на обоих итогах звучат настоящие голоса (компьютер и телефон)", async ({ browser, browserName }) => {
  test.setTimeout(240_000);
  // В WebKit партнёр — iPhone в отдельном WebKit; в Chromium — телефонный экран в том же браузере.
  const wk = browserName === "webkit";
  const other = wk ? await webkit.launch() : browser;
  // WebKit не знает разрешений буфера обмена: только микрофон.
  const mic = wk ? { permissions: ["microphone"] } : {};
  try {
    const { a, b, errors } = await sharedRoom({ browser, options: mic }, { browser: other, options: { ...(wk ? iphone : phone), ...mic } });
    const uploads = [a.page, b.page].map((p) => p.waitForResponse((r) => r.request().method() === "PUT" && VOICE_PUT.test(r.url()), { timeout: 90_000 }));
    await sing(a.page, b.page);
    for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
    for (const u of uploads) expect((await u).status(), "сервер принял запись").toBe(204);
    // Обе записи здесь — настоящие голоса выбраны сами, без нажатий.
    for (const p of [a.page, b.page]) {
      await expect(real(p)).toBeEnabled({ timeout: 30_000 });
      await expect(real(p)).toHaveAttribute("aria-pressed", "true");
      await expect(p.locator(".voice-note")).toHaveCount(0);
    }
    await a.page.screenshot({ path: `${shots}/coop-voices-${browserName}-1366.png` });
    await b.page.screenshot({ path: `${shots}/coop-voices-${browserName}-phone.png`, fullPage: true });
    await noSideScroll(b.page, "итог на телефоне");
    await hearsRealVoices(a.page, "компьютер");
    await hearsRealVoices(b.page, "телефон");
    expect(errors, "ошибки страниц").toEqual([]);
    await a.context.close();
    await b.context.close();
  } finally {
    if (other !== browser) await other.close();
  }
});

test("итог открыт заново: обе записи берутся с сервера, настоящие голоса звучат", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  await sing(a.page, b.page);
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await a.page.reload();
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 15_000 });
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  // Линий высоты после перезагрузки нет: синтезированный голос недоступен, настоящие — да.
  await expect(a.page.getByRole("button", { name: "Синтезированный голос" })).toBeDisabled();
  await hearsRealVoices(a.page, "после перезагрузки");
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("своя запись не сохранилась: итог говорит почему, «Отправить ещё раз» доставляет её партнёру", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  // Обе попытки отправки (с повтором) обрываются сетью.
  let failing = true;
  await b.page.route(VOICE_PUT, (route) => (failing ? route.abort("failed") : route.continue()));
  await sing(a.page, b.page);
  await expect(b.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  await expect(b.page.getByText(/^Твоя запись не сохранилась на сервере, поэтому Вика слышит в твоих строках синтезированный голос/)).toBeVisible({ timeout: 15_000 });
  await expect(a.page.getByText(/^Ждём запись партнёра \(Гоша\)/)).toBeVisible();
  await b.page.screenshot({ path: `${shots}/coop-voices-resend-1366.png` });
  failing = false;
  const sent = b.page.waitForResponse((r) => r.request().method() === "PUT" && VOICE_PUT.test(r.url()));
  await b.page.getByRole("button", { name: "Отправить ещё раз" }).click();
  expect((await sent).status()).toBe(204);
  await expect(b.page.getByRole("button", { name: "Отправить ещё раз" })).toHaveCount(0);
  await expect(b.page.getByText(/^Твоя запись не сохранилась/)).toHaveCount(0);
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await hearsRealVoices(a.page, "после повторной отправки");
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("своя запись не сохранилась, а согласие снято: «Отправить ещё раз» больше не предлагается", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  await b.page.route(VOICE_PUT, (route) => route.abort("failed"));
  await sing(a.page, b.page);
  await expect(b.page.getByRole("button", { name: "Отправить ещё раз" })).toBeVisible({ timeout: 60_000 });
  await b.page.getByRole("button", { name: "Не делиться голосом и удалить записи" }).click();
  await expect(b.page.getByText(/^Записи голосов удалены/).first()).toBeVisible();
  await expect(b.page.getByRole("button", { name: "Отправить ещё раз" })).toHaveCount(0);
  await expect(b.page.getByText(/^Твоя запись не сохранилась/)).toHaveCount(0);
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("галочку сняли: «Согласны оба…» исчезает сразу, не дожидаясь ответа сервера", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(120_000);
  // Снятие согласия не доходит до сервера (сеть подвисла): сервер ещё видит согласие обоих.
  const { a, b, errors } = await sharedRoom({ browser }, { browser }, (p) =>
    p.routeWebSocket(/\/api\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const msg = JSON.parse(String(m));
        if (msg.type === "voice_share" && msg.on === false) return;
        server.send(m);
      });
      server.onMessage((m) => ws.send(m));
    }),
  );
  const both = a.page.getByText("Согласны оба: после песни прозвучат ваши настоящие голоса.");
  await expect(both).toBeVisible();
  await a.page.getByRole("checkbox", { name: /Поделиться голосом с партнёром/ }).uncheck();
  await expect(both).toHaveCount(0);
  await expect(b.page.getByText("Вика: согласие есть")).toBeVisible();
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});
