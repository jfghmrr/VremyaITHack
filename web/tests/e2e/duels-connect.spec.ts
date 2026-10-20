import { expect, test } from "@playwright/test";
import { player } from "./helpers";

test("переподключение на «Дуэлях»: пока кнопки выключены — «Подключаемся…», дольше 2,5 с — плашка с причиной", async ({ browser }) => {
  const a = await player(browser, "Связь", "cn-earth", {});
  // Сервер дуэлей не принимает соединение: каждая попытка обрывается (тот же адрес, чтобы не мешала CSP).
  await a.context.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(_url: string | URL, protocols?: string | string[]) {
        super(`ws://${location.host}/api/ws-unavailable`, protocols);
      }
    } as typeof WebSocket;
  });
  await a.page.goto("/duels");
  const hint = a.page.getByText("Подключаемся…");
  await expect(hint).toBeVisible();
  await expect(a.page.getByRole("button", { name: "Найти соперника" })).toBeDisabled();
  await expect(a.page.getByRole("button", { name: "Создать комнату" })).toBeDisabled();
  await a.page.screenshot({ path: "test-results/duels-connecting.png" });
  // Связи нет дольше 2,5 с: подсказку сменяет плашка с причиной и кнопкой «Переподключить».
  await expect(a.page.getByText(/Связь с сервером дуэлей прервалась/)).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByRole("button", { name: "Переподключить" })).toBeVisible();
  await expect(hint).toHaveCount(0);
  await a.context.close();
});
