// «Вместе», минус под голосами на итоге: «Прослушать» нажато сразу, пока минус песни ещё
// загружается, — звук ждёт его («Готовим минус…») и стартует вместе с ним на одном контексте,
// и синтезированный голос, и настоящие голоса после передачи. Раньше в этом окне голоса звучали
// без минуса. Если минус не загрузился вовсе, голоса звучат без него, и итог говорит об этом.
import { expect, test } from "@playwright/test";
import { closed, handedOverCleanly, holdPartnerUpload, instrumentalReady, listenButton, plays, sharedRoom, sing, stoppedEarly } from "./coop-voice-bench";

const INSTRUMENTAL = /\/songs\/cn-earth\/instrumental\.mp3/;

test("«Прослушать» сразу, минус ещё грузится: звук ждёт минус и стартует вместе с ним, передача — с тем же минусом", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "сценарий времени, достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  // Минус итога у Вики приходит через 2,5 с после запроса (минус сцены — другой файл).
  await a.page.route(INSTRUMENTAL, async (route) => {
    await new Promise((r) => setTimeout(r, 2_500));
    await route.continue();
  });
  const release = await holdPartnerUpload(b.page);
  await sing(a.page, b.page);
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  const before = (await plays(a.page)).length;
  await listenButton(a.page).click();
  // Нажатие принято, минус готовится: голоса без него не звучат.
  await expect(a.page.getByRole("button", { name: "Готовим минус…" })).toBeVisible();
  expect((await plays(a.page)).slice(before)).toEqual([]);
  await expect.poll(async () => (await plays(a.page)).slice(before).filter((r) => r.kind === "synth").length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(listenButton(a.page)).toBeVisible();
  const first = (await plays(a.page)).slice(before);
  const synth = first.filter((r) => r.kind === "synth");
  const backing = first.filter((r) => r.kind === "backing" && r.ctx === synth[0].ctx);
  expect(backing, "минус на контексте прослушивания").toHaveLength(1);
  for (const s of synth) expect(Math.abs(s.start - backing[0].start), "голос и минус по одним часам").toBeLessThan(0.001);
  // Запись партнёра пришла — сведение с тем же минусом, без паузы.
  release();
  await expect.poll(async () => (await plays(a.page)).slice(before).filter((r) => r.kind === "real").length, { timeout: 20_000 }).toBe(2);
  const all = (await plays(a.page)).slice(before);
  handedOverCleanly(all);
  await expect(a.page.getByText(/Минус песни не загрузился/)).toHaveCount(0);
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await stoppedEarly(a.page, synth[0].ctx);
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("минус не загрузился: голоса звучат без него, итог говорит об этом", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  await a.page.route(INSTRUMENTAL, (route) => route.abort("failed"));
  await sing(a.page, b.page);
  await expect(a.page.getByRole("button", { name: "Настоящие голоса" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  const before = (await plays(a.page)).length;
  await listenButton(a.page).click();
  await expect.poll(async () => (await plays(a.page)).slice(before).filter((r) => r.kind === "real").length, { timeout: 10_000 }).toBe(2);
  const started = (await plays(a.page)).slice(before);
  expect(started.filter((r) => r.kind === "backing"), "без минуса").toEqual([]);
  await expect(a.page.getByText("Минус песни не загрузился, поэтому голоса звучат без него. Проверь связь и нажми «Прослушать» ещё раз.")).toBeVisible();
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await expect(a.page.getByText(/Минус песни не загрузился/)).toHaveCount(0);
  expect(errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test("«Стоп», пока контекст звука ещё запускается: без ошибок страницы, звук не начинается", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "достаточно одного движка");
  test.setTimeout(240_000);
  const { a, b, errors } = await sharedRoom({ browser }, { browser });
  await sing(a.page, b.page);
  await expect(a.page.getByRole("heading", { name: "Общий балл" })).toBeVisible({ timeout: 60_000 });
  await instrumentalReady(a.page);
  // Контекст прослушивания стартует 3 с (медленный телефон); «Стоп» нажат раньше.
  await a.page.evaluate(() => ((window as unknown as { __slowResume: number }).__slowResume = 3_000));
  const before = (await plays(a.page)).length;
  const closedBefore = (await closed(a.page)).length;
  await listenButton(a.page).click();
  await a.page.getByRole("button", { name: "■ Стоп" }).click();
  await a.page.waitForTimeout(3_800);
  expect((await plays(a.page)).slice(before), "звук не начался").toEqual([]);
  expect((await closed(a.page)).length, "контекст прослушивания закрыт").toBeGreaterThan(closedBefore);
  await expect(a.page.getByText(/Не удалось запустить звук/)).toHaveCount(0);
  expect(errors, "ошибки страницы (в том числе необработанный отказ resume)").toEqual([]);
  await a.context.close();
  await b.context.close();
});
