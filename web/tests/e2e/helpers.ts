import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { fakeMic, type MicOptions } from "./fake-mic";
import { documents } from "../../src/lib/legal/operator";

export const password = "Long-demo-pass-2026";

/** Состояние браузера с уже принятыми уведомлением о cookie и согласием на запись голоса (для новых контекстов). */
export const accepted = () => {
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:4173";
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: "perepev.cookies", value: "test" }, { name: "perepev.voiceConsent", value: documents.consent }] }],
  };
};

/** Новый пользователь через API (тот же Origin, что у сайта) и страница с его сессией. */
export async function player(browser: Browser, name: string, song: string, mic: MicOptions, options: BrowserContextOptions = {}): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const context = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"], storageState: accepted(), ...options });
  await fakeMic(context, song, mic);
  const page = await context.newPage();
  await page.goto("/");
  const email = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const r = await page.evaluate(
    async ({ email, name, password }) => {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-perepev-request": "1" },
        body: JSON.stringify({ email, name, password, consent: true, ageGroup: "14plus" }),
      });
      return res.status;
    },
    { email, name, password },
  );
  expect(r).toBe(201);
  await page.reload();
  return { context, page, email };
}

/** Команды, которые страница отправила по WebSocket дуэлей, со временем отправки. */
export type SentCommands = { at: number; msg: Record<string, unknown> }[];
export function sentCommands(page: Page): SentCommands {
  const sent: SentCommands = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      try {
        sent.push({ at: Date.now(), msg: JSON.parse(String(f.payload)) });
      } catch {
        /* не JSON */
      }
    }),
  );
  return sent;
}

/** Номер матча из адреса /duels/match/<id>. */
export const matchIdOf = (page: Page) => new URL(page.url()).pathname.match(/^\/duels\/match\/([^/]+)$/)?.[1] ?? null;

/** Баллы на экране итога дуэли: [свой, соперника]. */
export const duelScores = async (page: Page) => (await page.locator(".col .score").allTextContents()).map((s) => s.trim());

/**
 * Реванш спет до итога, и это новое исполнение нажавшего «Реванш», а не прошлое. Раньше переход
 * /duels/match/<старый> → /duels/match/<новый> переиспользовал компонент прошлого матча: минусовка
 * не запускалась, точки нового матча не уходили, а после пения сервер получал прошлую кривую.
 * Оба уже на «Подготовке» нового матча; у нажавшего в этом реванше ошибки в мелодии, поэтому его
 * балл заметно ниже прошлого.
 */
export async function singFreshRematch({ presser, other, sent, firstId, firstScore }: { presser: Page; other: Page; sent: SentCommands; firstId: string; firstScore: number }) {
  const id = matchIdOf(presser);
  expect(id, "реванш — новый матч").not.toBeNull();
  expect(id).not.toBe(firstId);
  expect(matchIdOf(other)).toBe(id);
  // Ошибки по всей песне (2 с из каждых 4 с, знак чередуется): песню выбирает сервер, и окна
  // только в первых секундах попадали в паузу перед пением — балл тогда почти не падал.
  await presser.evaluate(() => {
    (window as unknown as { __mic: { errors: [number, number, number][] } }).__mic.errors = Array.from({ length: 15 }, (_, k) => [100 + k * 400, 300 + k * 400, k % 2 ? -2.5 : 2.5]);
  });
  // «Прослушать» в разборе тоже запускает минусовку с начала, поэтому считаем запуски от значения перед реваншем.
  const startsBefore = await presser.evaluate(() => (window as unknown as { __mic: { starts?: number } }).__mic.starts ?? 0);
  for (const p of [presser, other]) await p.getByRole("button", { name: "Я готов" }).click();
  for (const p of [presser, other]) await expect(p.getByLabel("Пение в дуэли")).toBeVisible({ timeout: 15_000 });
  // Линия отправляется по ходу пения: счётчик растёт с нуля, а не стоит на прошлом «M из M».
  const progress = presser.getByText(/Твоя линия: отправлено \d+ из \d+ точ/);
  await expect
    .poll(async () => {
      const [, n, m] = (await progress.textContent())?.match(/отправлено (\d+) из (\d+)/) ?? [];
      return Number(n) > 0 && Number(n) < Number(m);
    }, { timeout: 30_000 })
    .toBe(true);
  // Минусовка нового матча запущена ровно один раз: «певец» начал петь заново.
  expect(await presser.evaluate(() => (window as unknown as { __mic: { starts?: number } }).__mic.starts)).toBe(startsBefore + 1);
  for (const p of [presser, other]) await expect(p.getByRole("heading", { name: /Победа|Поражение|Ничья/ })).toBeVisible({ timeout: 70_000 });
  // Точки ушли в новый матч по ходу песни, а не одной пачкой после неё.
  const perf = sent.filter((s) => s.msg.type === "perf" && s.msg.match_id === id);
  expect(perf.length).toBeGreaterThan(0);
  expect(perf.at(-1)!.at - perf[0].at, "точки отправлены за время пения").toBeGreaterThan(5_000);
  // Итог подтверждён сервером для обоих и считает новое исполнение.
  const [mine, theirs] = await duelScores(presser);
  expect(await duelScores(other)).toEqual([theirs, mine]);
  expect(Number(mine), "сервер оценил новую попытку с ошибками, а не прошлую").toBeLessThan(firstScore - 5);
  return id!;
}
