// «Вместе», передача синтезированного голоса настоящим голосам — гонки, из-за которых владелец
// слышал синтез при согласии обоих (2026-10-18): «Прослушать» нажато до прихода записи партнёра;
// запись пришла, пока звук ещё запускался; запись пришла через 70 с; «Стоп» и уход со страницы
// во время передачи. Без двойного звучания и без паузы минуса (зонд следит и за остановками).
import { expect, test } from "@playwright/test";
import { VOICE_PUT, instrumentalReady, plays, handedOverCleanly, sharedRoom, sing, real, listenButton, clockOf, seconds, hearsRealVoices, stoppedEarly, holdPartnerUpload } from "./coop-voice-bench";

test("«Прослушать» нажато до прихода записи партнёра: синтезированный голос сменяется настоящими голосами", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "сценарий времени, достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  // Запись партнёра идёт 4 с (медленная сеть телефона).
  await b.page.route(VOICE_PUT, async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue();
  });
  await sing(a.page, b.page);
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  await expect(a.page.getByText(/^Ждём запись партнёра \(Гоша\)/)).toBeVisible();
  await instrumentalReady(a.page);
  await listenButton(a.page).click();
  await expect.poll(async () => (await plays(a.page)).filter((s) => s.kind === "synth").length).toBeGreaterThan(0);
  await expect(a.page.getByTestId("listen-note")).toHaveText(/^Звучит синтезированный голос/);
  // Запись пришла — с того же места звучат настоящие голоса, и пояснение говорит именно это.
  await expect.poll(async () => (await plays(a.page)).filter((s) => s.kind === "real").length, { timeout: 20_000 }).toBe(2);
  await expect(a.page.getByTestId("listen-note")).toHaveText(/^Звучат ваши настоящие голоса/);
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true");
  const all = await plays(a.page);
  const synth = all.filter((s) => s.kind === "synth");
  const voices = all.filter((s) => s.kind === "real");
  expect(voices[0].ctx, "на том же контексте, без нового нажатия").toBe(synth[0].ctx);
  handedOverCleanly(all);
  // Звук не начался заново: счётчик идёт дальше.
  expect(await seconds(a.page)).toBeGreaterThan(3);
  await expect(a.page.locator(".voice-note")).toHaveCount(0);
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await stoppedEarly(a.page, voices[0].ctx);
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("запись партнёра пришла, пока синтез запускался: после запуска он сменяется настоящими голосами", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "сценарий времени, достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  const release = await holdPartnerUpload(b.page);
  await sing(a.page, b.page);
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  await expect(a.page.getByText(/^Ждём запись партнёра \(Гоша\)/)).toBeVisible();
  // Запуск звука по нажатию ждёт контекст 3,5 с (медленный телефон); запись партнёра приходит
  // как раз в это окно — между нажатием и началом синтезированного голоса.
  await a.page.evaluate(() => ((window as unknown as { __slowResume: number }).__slowResume = 3_500));
  const before = (await plays(a.page)).length;
  await instrumentalReady(a.page);
  await listenButton(a.page).click();
  release();
  await expect.poll(() => a.page.evaluate(() => (window as unknown as { __voiceAt: number[] }).__voiceAt.length), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await plays(a.page)).slice(before).filter((r) => r.kind === "real").length, { timeout: 20_000 }).toBe(2);
  const all = (await plays(a.page)).slice(before);
  const voiceAt = await a.page.evaluate(() => (window as unknown as { __voiceAt: number[] }).__voiceAt[0]);
  const firstSynth = Math.min(...all.filter((r) => r.kind === "synth").map((r) => r.at));
  expect(voiceAt, "запись пришла раньше, чем зазвучал синтез").toBeLessThan(firstSynth);
  handedOverCleanly(all);
  await expect(a.page.getByTestId("listen-note")).toHaveText(/^Звучат ваши настоящие голоса/);
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true");
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await stoppedEarly(a.page, all.find((r) => r.kind === "real")!.ctx);
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

for (const how of ["«Стоп»", "уход со страницы"] as const) {
  test(`${how} во время передачи: ни синтез, ни сведение не звучат, контекст закрыт`, async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "сценарий времени, достаточно одного движка");
    test.setTimeout(240_000);
    const { a, b, errors } = await sharedRoom({ browser }, { browser });
    const release = await holdPartnerUpload(b.page);
    await sing(a.page, b.page);
    await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
    const before = (await plays(a.page)).length;
    await instrumentalReady(a.page);
    await listenButton(a.page).click();
    await expect.poll(async () => (await plays(a.page)).slice(before).filter((r) => r.kind === "synth").length).toBeGreaterThan(0);
    const ctx = (await plays(a.page)).slice(before).find((r) => r.kind === "synth")!.ctx;
    // Передача начнётся и застрянет на 3 с в запуске сведения — в это время игрок нажимает «Стоп» или уходит.
    await a.page.evaluate(() => ((window as unknown as { __slowResume: number }).__slowResume = 3_000));
    release();
    await expect.poll(() => a.page.evaluate(() => (window as unknown as { __resumeWaits: number }).__resumeWaits), { timeout: 15_000 }).toBe(1);
    if (how === "«Стоп»") await a.page.getByRole("button", { name: "■ Стоп" }).click();
    else await a.page.getByRole("link", { name: "К дуэлям" }).click();
    await a.page.waitForTimeout(3_800);
    const after = (await plays(a.page)).slice(before);
    expect(after.filter((r) => r.kind === "real"), "сведение не зазвучало").toEqual([]);
    await stoppedEarly(a.page, ctx);
    if (how === "«Стоп»") {
      await expect(clockOf(a.page)).toHaveCount(0);
      await expect(a.page.getByText(/Не удалось запустить звук/)).toHaveCount(0);
    } else await expect(a.page).toHaveURL(/\/duels$/);
    expect(errors).toEqual([]);
    await a.context.close();
    await b.context.close();
  });
}

test("запись партнёра пришла через 70 с (срок отправки 90 с): итог дождался её, а не сдался через минуту", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "сценарий времени, достаточно одного движка");
  test.setTimeout(300_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  await b.page.route(VOICE_PUT, async (route) => {
    await new Promise((r) => setTimeout(r, 70_000));
    await route.continue();
  });
  await sing(a.page, b.page);
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  await a.page.waitForTimeout(62_000);
  await expect(a.page.getByText(/^Ждём запись партнёра/)).toBeVisible();
  await expect(real(a.page)).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await hearsRealVoices(a.page, "после долгого ожидания");
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});
