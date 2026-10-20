// «Вместе»: двое поют песню по очереди в комнате друга. Две вкладки с синтетическим микрофоном
// (каждый «поёт» всю песню, на сервер уходят только свои ходы): выбор режима, ярлыки ходов и
// подсказка на сцене (компьютер и телефон), итог с общим баллом и партиями, «Прослушать всю
// песню», «Ещё раз вместе». Плюс записка гостя на /duels на узком телефоне (аудит F7).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { player } from "./helpers";

const shots = process.env.COOP_SHOTS ?? "test-results/coop";
mkdirSync(shots, { recursive: true });
const phone = (width: number, height: number) => ({ viewport: { width, height }, isMobile: true, hasTouch: true });

async function noSideScroll(page: Page, where: string) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${where}: горизонтальная прокрутка`).toBeLessThanOrEqual(page.viewportSize()!.width);
}

/** Тексты ярлыков и подсказок, замеченные на сцене за время песни. */
function watchLabels(page: Page) {
  const seen = new Set<string>();
  const timer = setInterval(async () => {
    try {
      for (const t of await page.locator(".lyric-strip .who, .cue").allInnerTexts()) seen.add(t.trim());
    } catch {
      /* страница сменилась */
    }
  }, 200);
  return { seen, stop: () => clearInterval(timer) };
}

test("«Вместе»: режим в карточке, ходы на сцене, общий балл, прослушивание всей песни, ещё раз", async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await player(browser, "Аня", "cn-earth", { shift: -5 });
  const b = await player(browser, "Борис", "cn-earth", { shift: 4, errors: [[700, 900, 1.6]] }, phone(390, 844));
  // Ошибки страницы (например, в отрисовке графика по точкам партнёра) — провал сценария.
  const errors: string[] = [];
  for (const p of [a.page, b.page]) p.on("pageerror", (e) => errors.push(e.message));
  // Без согласия на голос запись никуда не уходит.
  const voiceTraffic: string[] = [];
  for (const p of [a.page, b.page]) p.on("request", (r) => r.url().includes("/voice") && voiceTraffic.push(r.url()));

  await a.page.goto("/duels");
  const card = a.page.locator(".mode.ticket");
  await expect(card.getByRole("button", { name: "Кто лучше" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Вместе" }).click();
  await expect(card.getByRole("button", { name: "Вместе" })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText(/поёте одну песню по очереди, по строке/)).toBeVisible();
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
  await card.screenshot({ path: `${shots}/coop-card-1366.png` });
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  await expect(a.page.getByRole("heading", { name: "Вместе: поёте по очереди, без рейтинга" })).toBeVisible();
  await a.page.screenshot({ path: `${shots}/coop-room-1366.png` });
  const code = (await a.page.locator(".code").textContent())!.trim();

  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  await expect(a.page.getByText(/Поёте по очереди: 3 хода/)).toBeVisible();
  await expect(a.page.getByText(/Начинаешь ты\./)).toBeVisible();
  // Согласие поделиться голосом по умолчанию выключено.
  await expect(a.page.getByRole("checkbox", { name: /Поделиться голосом с партнёром/ })).not.toBeChecked();
  await expect(b.page.getByText(/Начинает Аня\./)).toBeVisible();
  await a.page.screenshot({ path: `${shots}/coop-ready-1366.png` });
  for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Я готов" }).click();

  for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение вместе")).toBeVisible({ timeout: 15_000 });
  const la = watchLabels(a.page);
  const lb = watchLabels(b.page);
  // Перед первым ходом — подсказка: Аня поёт первой.
  await expect(a.page.locator(".cue")).toHaveText("Сейчас поёшь ты", { timeout: 10_000 });
  await expect(b.page.locator(".cue")).toHaveText("Сейчас поёт Аня");
  await expect(a.page.locator(".lyric-strip .who")).toHaveText("Твоя строка", { timeout: 10_000 });
  await a.page.screenshot({ path: `${shots}/coop-stage-1366.png` });
  await b.page.screenshot({ path: `${shots}/coop-stage-390x844.png` });
  // Ход Бориса: у него «Твоя строка», у Ани — «Поёт Борис».
  await expect(a.page.locator(".lyric-strip .who")).toHaveText("Поёт Борис", { timeout: 10_000 });
  await expect(b.page.locator(".lyric-strip .who")).toHaveText("Твоя строка");
  await a.page.screenshot({ path: `${shots}/coop-stage-partner-1366.png` });
  // Телефон боком: сцена помещается, строка и ярлык видны.
  await b.page.setViewportSize({ width: 844, height: 390 });
  await b.page.waitForTimeout(600);
  await b.page.screenshot({ path: `${shots}/coop-stage-844x390.png` });
  await expect(b.page.getByRole("region", { name: "Слова песни" }).locator(".now")).toBeInViewport();
  await expect(b.page.getByRole("button", { name: "Выйти" })).toBeInViewport();
  await noSideScroll(b.page, "сцена 844x390");
  await b.page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(b.page, "сцена 390x844");

  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  la.stop();
  lb.stop();
  for (const label of ["Твоя строка", "Поёт Борис", "Сейчас поёшь ты", "Сейчас поёт Борис"]) expect(la.seen, `Аня видела «${label}»`).toContain(label);
  for (const label of ["Твоя строка", "Поёт Аня", "Сейчас поёшь ты", "Сейчас поёт Аня"]) expect(lb.seen, `Борис видел «${label}»`).toContain(label);
  // Ни слова о победе и поражении.
  await expect(a.page.getByText(/победа|поражение|ничья|соперник/i)).toHaveCount(0);
  // Почему не звучат настоящие голоса — сказано прямо.
  await expect(a.page.getByText("Настоящие голоса не звучат: перед песней не было согласия поделиться голосом ни у тебя, ни у партнёра.")).toBeVisible();
  // Один подтверждённый итог: общий балл совпадает, партии зеркальны.
  const team = async (p: Page) => (await p.getByTestId("team-score").textContent())!.trim();
  const parts = async (p: Page) => (await p.getByTestId("part-score").allTextContents()).map((s) => s.trim());
  expect(await team(a.page)).toBe(await team(b.page));
  const [mineA, theirsA] = await parts(a.page);
  expect(await parts(b.page)).toEqual([theirsA, mineA]);
  const num = (s: string) => Number(s.replace(",", "."));
  expect(num(mineA)).toBeGreaterThan(85);
  expect(num(theirsA)).toBeGreaterThan(60);
  expect(num(await team(a.page))).toBeGreaterThanOrEqual(Math.min(num(mineA), num(theirsA)));
  expect(num(await team(a.page))).toBeLessThanOrEqual(Math.max(num(mineA), num(theirsA)));
  await a.page.waitForTimeout(800);
  await a.page.screenshot({ path: `${shots}/coop-result-1366.png` });
  await a.page.setViewportSize({ width: 1920, height: 1080 });
  await a.page.screenshot({ path: `${shots}/coop-result-1920.png` });
  await a.page.setViewportSize({ width: 1366, height: 768 });
  await b.page.screenshot({ path: `${shots}/coop-result-390x844.png`, fullPage: true });
  await noSideScroll(b.page, "итог 390x844");

  // «Прослушать всю песню»: звук идёт (счётчик растёт) и останавливается.
  const listen = a.page.getByRole("button", { name: "▶ Прослушать всю песню" });
  await listen.click();
  await expect(listen).toHaveAttribute("aria-pressed", "true");
  const clock = a.page.locator(".listen .mono");
  await expect(clock).toHaveText(/\/ 13,9 с$/);
  await expect.poll(async () => num((await clock.textContent())!.split(" / ")[0]), { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(a.page.getByText(/Звучит синтезированный голос, который повторяет мелодию каждого из вас/)).toBeVisible();
  // Линия партнёра дошла: звучат обе партии.
  await expect(a.page.getByText(/до этого устройства не дошла/)).toHaveCount(0);
  await a.page.screenshot({ path: `${shots}/coop-result-listening-1366.png` });
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(clock).toHaveCount(0);

  // «Ещё раз вместе»: снова «Вместе» с той же песней, у партнёра — приглашение.
  await a.page.getByRole("button", { name: "Ещё раз вместе" }).click();
  await expect(a.page.getByRole("heading", { name: "Ещё раз вместе: ждём друга" })).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByRole("heading", { name: "Вместе: поёте по очереди, без рейтинга" })).toBeVisible();
  await expect(b.page.getByText(/Аня зовёт спеть ещё раз вместе/).first()).toBeVisible({ timeout: 10_000 });
  await b.page.getByRole("link", { name: "Спеть ещё раз" }).first().click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByRole("heading", { name: /^Вместе, по очереди, без рейтинга · «.+»$/ })).toBeVisible();
  await a.page.getByRole("button", { name: "← К дуэлям" }).click();
  expect(errors, "ошибки страниц").toEqual([]);
  expect(voiceTraffic, "без согласия голос не отправляется").toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("«Вместе» с согласием обоих: голоса уходят партнёру, в конце звучат настоящие голоса", async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await player(browser, "Вика", "cn-earth", { shift: -3 });
  const b = await player(browser, "Гоша", "cn-earth", { shift: 5 });
  const errors: string[] = [];
  for (const p of [a.page, b.page]) p.on("pageerror", (e) => errors.push(e.message));
  // Сбой снятия согласия по команде: сервер «отвечает» отказом, пока failWithdraw включён.
  let failWithdraw = false;
  await a.page.routeWebSocket(/\/api\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (failWithdraw && msg.type === "voice_share" && msg.on === false) return ws.send(JSON.stringify({ v: 1, type: "ack", id: msg.id, ok: false, error: "Сервер временно недоступен." }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await a.page.goto("/duels");
  await a.page.locator(".mode.ticket").getByRole("button", { name: "Вместе" }).click();
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  const code = (await a.page.locator(".code").textContent())!.trim();
  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  const share = (p: Page) => p.getByRole("checkbox", { name: /Поделиться голосом с партнёром/ });
  await share(a.page).check();
  // Партнёр видит согласие Вики, затем соглашается сам.
  await expect(b.page.getByText("Вика: согласие есть")).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByText("Гоша: пока без согласия")).toBeVisible();
  await share(b.page).check();
  await expect(a.page.getByText("Гоша: согласие есть")).toBeVisible({ timeout: 10_000 });
  await a.page.screenshot({ path: `${shots}/coop-ready-share-1366.png` });
  const uploads = [a.page, b.page].map((p) => p.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/matches\/[^/]+\/voice$/.test(r.url()), { timeout: 90_000 }));
  for (const p of [a.page, b.page]) await p.getByRole("button", { name: "Я готов" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение вместе")).toBeVisible({ timeout: 15_000 });
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  // Каждый отправил свою запись (только свои ходы), сервер принял.
  for (const u of uploads) expect((await u).status()).toBe(204);
  // Голос партнёра пришёл: по умолчанию звучат настоящие голоса.
  const real = a.page.getByRole("button", { name: "Настоящие голоса" });
  await expect(real).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(a.page.getByText(/Звучат ваши настоящие голоса/)).toBeVisible();
  const listen = a.page.getByRole("button", { name: "▶ Прослушать всю песню" });
  await listen.click();
  const clock = a.page.locator(".listen .mono");
  await expect(clock).toHaveText(/\/ 13,9 с$/);
  await expect.poll(async () => Number((await clock.textContent())!.split(" / ")[0].replace(",", ".")), { timeout: 10_000 }).toBeGreaterThan(1);
  await a.page.screenshot({ path: `${shots}/coop-result-real-voices-1366.png` });
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await expect(clock).toHaveCount(0);
  // Синтезированный голос остаётся выбором.
  await a.page.getByRole("button", { name: "Синтезированный голос" }).click();
  await expect(a.page.getByText(/Звучит синтезированный голос, который повторяет мелодию/)).toBeVisible();
  // Согласие снимается и после песни: записи удаляются, партнёр их больше не получает.
  const matchId = new URL(a.page.url()).pathname.split("/").at(-1)!;
  const status = (p: Page, slot: number) => p.evaluate(async ([id, s]) => (await fetch(`/api/matches/${id}/voice/${s}`)).status, [matchId, slot] as const);
  expect(await status(b.page, 0)).toBe(200);
  // После перезагрузки итога согласие обоих известно серверу: пояснение честное, кнопка снятия на месте.
  await a.page.reload();
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 15_000 });
  const withdraw = a.page.getByRole("button", { name: "Не делиться голосом и удалить записи" });
  await expect(withdraw).toBeVisible();
  await expect(a.page.getByText(/не записывается/)).toHaveCount(0);
  // Снятие не дошло до сервера: «удалены» не показывается, кнопка остаётся, видна ошибка.
  failWithdraw = true;
  await withdraw.click();
  await expect(a.page.getByText(/Не удалось снять согласие/)).toBeVisible();
  await expect(withdraw).toBeVisible();
  await expect(a.page.getByText(/Записи голосов удалены/)).toHaveCount(0);
  expect(await status(b.page, 0)).toBe(200);
  failWithdraw = false;
  await withdraw.click();
  await expect(a.page.getByText(/Записи голосов удалены/)).toBeVisible();
  await expect(a.page.getByRole("button", { name: "Настоящие голоса" })).toHaveCount(0);
  await expect.poll(() => status(b.page, 0), { timeout: 10_000 }).toBe(403);
  expect(await status(b.page, 1)).toBe(403);
  expect(errors, "ошибки страниц").toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("гость на /duels: записка о кабинете не сжимается рядом со ссылкой (F7)", async ({ browser }) => {
  for (const width of [360, 390]) {
    const context = await browser.newContext({ ...phone(width, 800) });
    const page = await context.newPage();
    await page.goto("/duels");
    const note = page.locator(".notice.guest");
    await expect(note).toBeVisible();
    const text = await note.locator("span").boundingBox();
    const link = await note.getByRole("link", { name: "Войти или зарегистрироваться" }).boundingBox();
    const box = await note.boundingBox();
    // Текст занимает ширину записки, а ссылка — под ним, а не сбоку.
    expect(text!.width, `${width}: ширина текста`).toBeGreaterThan(box!.width * 0.75);
    expect(link!.y, `${width}: ссылка под текстом`).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
    const lines = await note.locator("span").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "20")));
    expect(lines, `${width}: строк текста`).toBeLessThanOrEqual(3);
    await page.screenshot({ path: `${shots}/duels-guest-${width}.png` });
    await context.close();
  }
});
