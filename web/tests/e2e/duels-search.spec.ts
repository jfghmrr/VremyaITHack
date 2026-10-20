import { expect, test } from "@playwright/test";
import { player } from "./helpers";

// Поиск соперника говорит правду: почему пары нет, и не заканчивается молча, если страница
// надолго теряла связь (телефон в кармане, вкладка в фоне): сервер снимает заявку через 30 с
// без heartbeat, а клиент после переподключения продолжает поиск сам.
test("поиск: пояснение «больше никто не ищет» и продолжение после долгого разрыва", async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await player(browser, "Ищущий", "cn-earth", {});
  // Тест управляет связью: при window.__offline новые соединения не проходят, а открытые закрываются.
  // window.__note подменяет пояснение в состоянии поиска от сервера (самое длинное — для проверки вёрстки).
  await a.context.addInitScript(() => {
    const Native = window.WebSocket;
    const w = window as unknown as { __offline: boolean; __sockets: WebSocket[]; __note: string };
    w.__offline = false;
    w.__sockets = [];
    w.__note = "";
    const rewrite = (data: unknown) => {
      if (!w.__note || typeof data !== "string") return data;
      const m = JSON.parse(data);
      if (m.type !== "queue" || m.state?.status !== "searching") return data;
      m.state.note = w.__note;
      return JSON.stringify(m);
    };
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(w.__offline ? `ws://${location.host}/api/ws-unavailable` : url, protocols);
        w.__sockets.push(this);
      }
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = fn && ((e: MessageEvent) => fn.call(this, new MessageEvent("message", { data: rewrite(e.data) })));
      }
      get onmessage() {
        return super.onmessage;
      }
    } as typeof WebSocket;
  });
  await a.page.goto("/duels");
  await a.page.getByRole("button", { name: "Найти соперника" }).click();
  await expect(a.page.getByText(/Ищем соперника/)).toBeVisible();
  // Подбор сообщает, что сейчас в поиске больше никого нет, а не крутится молча.
  await expect(a.page.getByText("Сейчас больше никто не ищет соперника", { exact: false })).toBeVisible({ timeout: 10_000 });
  await a.page.screenshot({ path: "test-results/duels-search-alone.png" });

  // Связи нет 35 секунд: сервер закрывает соединение и снимает заявку (30 с без heartbeat).
  await a.page.evaluate(() => {
    const w = window as unknown as { __offline: boolean; __sockets: WebSocket[] };
    w.__offline = true;
    for (const s of w.__sockets) s.close();
  });
  await expect(a.page.getByText(/Связь с сервером дуэлей прервалась/)).toBeVisible({ timeout: 10_000 });
  await a.page.waitForTimeout(35_000);
  await a.page.evaluate(() => {
    (window as unknown as { __offline: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
  // Поиск продолжается сам: игрок видит, что он начат заново, и снова ищет.
  await expect(a.page.getByText("связь прерывалась, поиск начат заново")).toBeVisible({ timeout: 15_000 });
  await expect(a.page.getByText(/Ищем соперника, 0:0\d/)).toBeVisible();
  await expect(a.page.getByRole("button", { name: "Отменить поиск" })).toBeVisible();
  await a.page.screenshot({ path: "test-results/duels-search-resumed.png" });

  // Самое длинное пояснение сервера (лимит пары, две строки) вместе со строкой о продолжении поиска
  // помещается в 1366×768 без прокрутки страницы.
  const longest = "Соперник в поиске есть, но с ним сегодня уже сыграно 3 рейтинговых матча — больше подбор вас не сводит. Сыграйте без рейтинга: «Играть с другом».";
  await a.page.evaluate((note) => ((window as unknown as { __note: string }).__note = note), longest);
  await expect(a.page.getByText(longest)).toBeVisible({ timeout: 10_000 });
  await a.page.evaluate(() => document.fonts.ready);
  const box = await a.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
  await a.page.screenshot({ path: "test-results/duels-search-longest-note-1366.png" });
  expect(box.sh, "длинное пояснение: без вертикальной прокрутки в 1366×768").toBeLessThanOrEqual(768);
  expect(box.sw).toBeLessThanOrEqual(1366);
  for (const [w, h] of [[800, 768], [390, 844]]) {
    await a.page.setViewportSize({ width: w, height: h });
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth), `${w}: без горизонтальной прокрутки`).toBeLessThanOrEqual(w);
    await a.page.screenshot({ path: `test-results/duels-search-longest-note-${w}.png`, fullPage: true });
  }
  await a.page.setViewportSize({ width: 1366, height: 768 });
  // Отмена — выбор игрока: поиск не возобновляется.
  await a.page.getByRole("button", { name: "Отменить поиск" }).click();
  await expect(a.page.getByRole("button", { name: "Найти соперника" })).toBeVisible();
  await a.context.close();
});
