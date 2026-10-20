import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { duelScores, matchIdOf, player, sentCommands, singFreshRematch } from "./helpers";
import { shoot } from "./shoot";

test("живая дуэль с другом: комната, готовность, общий старт, одинаковый результат", async ({ browser }) => {
  // Обе вкладки поют выбранный вокальный фрагмент в разных тональностях.
  const a = await player(browser, "Аня", "cn-earth", { shift: -5 });
  const b = await player(browser, "Борис", "cn-earth", { shift: 4, errors: [[200, 400, 1.6], [1100, 1300, -1.8]] });
  const sent = sentCommands(a.page);

  await a.page.goto("/duels");
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption("cn-earth");
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  const code = (await a.page.locator(".code").textContent())!.trim();
  await shoot(a.page, "duel-room", [[1366, 768]]);

  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  await shoot(b.page, "duel-ready", [[1366, 768]]);
  await a.page.getByRole("button", { name: "Я готов" }).click();
  await b.page.getByRole("button", { name: "Я готов" }).click();

  for (const p of [a.page, b.page]) await expect(p.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
  // Слова песни на сцене дуэли: строка, которая звучит сейчас, из reference.json выбранной песни.
  const song = JSON.parse(readFileSync(new URL("../../static/songs/cn-earth/reference.json", import.meta.url), "utf8")) as { lyrics: { t: number; text: string }[] };
  const words = song.lyrics.map((l) => l.text.replaceAll(" · ", " "));
  await expect(a.page.getByRole("region", { name: "Слова песни" })).toBeVisible();
  await expect.poll(async () => words.includes((await a.page.locator(".lyric-strip .now").innerText()).replace(/\s+/g, " ").trim()), { timeout: 15_000 }).toBe(true);
  await a.page.waitForTimeout(6_000);
  await a.page.screenshot({ path: "../docs/screens/duel-stage-1366.png" });
  // Индивидуальной паузы нет: пробел ничего не останавливает.
  await a.page.keyboard.press("Space");

  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 60_000 });
  await expect(a.page.getByRole("heading", { name: "Победа" })).toBeVisible();
  await expect(b.page.getByRole("heading", { name: "Поражение" })).toBeVisible();
  const sa = await duelScores(a.page);
  const sb = await duelScores(b.page);
  // Одинаковый подтверждённый результат: колонки зеркальны.
  expect(sa).toEqual([sb[1], sb[0]]);
  expect(Number(sa[0])).toBeGreaterThan(90);
  await a.page.waitForTimeout(1000);
  await shoot(a.page, "duel-result", [[1366, 768], [1920, 1080]]);
  await a.page.getByRole("button", { name: "Разбор и прослушивание" }).click();
  await expect(a.page.getByRole("heading", { name: "Разбор дуэли" })).toBeVisible();
  await shoot(a.page, "duel-analysis", [[1366,768]]);
  await a.page.getByRole("button", { name: "← К результату" }).click();
  const firstId = matchIdOf(a.page)!;
  await a.page.getByRole("button", { name: "Реванш", exact: true }).click();
  await expect(a.page.getByRole("heading", { name: "Реванш: ждём соперника" })).toBeVisible();
  await expect(b.page.getByText(/Аня зовёт на реванш/).first()).toBeVisible({ timeout: 10_000 });
  // На «Дуэлях» приглашение называет соперника и песню прошлого матча.
  await b.page.getByRole("link", { name: "К дуэлям" }).click();
  await expect(b.page.getByText(/Аня зовёт на реванш: «.+», без рейтинга/)).toBeVisible();
  await b.page.screenshot({ path: "test-results/duels-invite-banner.png" });
  await b.page.getByRole("link", { name: "Принять реванш" }).click();
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible();
  // Нажавший «Реванш» поёт реванш до итога: новая попытка, а не прошлая.
  await singFreshRematch({ presser: a.page, other: b.page, sent, firstId, firstScore: Number(sa[0]) });
  // «Назад» в браузере с итога реванша: снова итог первого матча, а не вечная загрузка.
  await a.page.goBack();
  await expect(a.page).toHaveURL(new RegExp(`/duels/match/${firstId}$`));
  await expect(a.page.getByRole("heading", { name: "Победа" })).toBeVisible({ timeout: 10_000 });
  expect(await duelScores(a.page)).toEqual(sa);
  await a.context.close();
  await b.context.close();
});
