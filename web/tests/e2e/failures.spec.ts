import { expect, test } from "@playwright/test";
import { fakeMic } from "./fake-mic";
import { player } from "./helpers";
import { shoot } from "./shoot";

test("микрофон запрещён: понятная ошибка и возможность повторить", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await expect(page.getByRole("alert")).toContainText("Нет доступа к микрофону");
  await expect(page.getByRole("button", { name: "Включить микрофон" })).toBeEnabled();
});

test("выбранное устройство отключено: подсказка выбрать другой вход", async ({ page, context }) => {
  await fakeMic(context, "cn-earth");
  await page.addInitScript(() => localStorage.setItem("perepev.inputDeviceId", "unplugged"));
  await page.goto("/sing/cn-earth");
  await expect(page.getByRole("combobox", { name: "Устройство ввода" })).toContainText("Сохранённый микрофон не подключён");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await expect(page.getByRole("alert")).toContainText("Выбранный микрофон не найден");
});

test("тишина: высокий балл не выдаётся", async ({ page, context }) => {
  await fakeMic(context, "cn-earth", { silent: true });
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await expect(page.getByText("Ничего не слышно")).toBeVisible();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page.getByRole("heading", { name: "Голоса почти не слышно." })).toBeVisible({ timeout: 40_000 });
  const label = await page.getByLabel(/из 100/).getAttribute("aria-label");
  expect(Number(label!.split(" ")[0])).toBeLessThanOrEqual(30);
  const closeAward = page.getByRole("button", { name: "Закрыть достижение" });
  if (await closeAward.isVisible()) await closeAward.click();
  await shoot(page, "result-silence", [[1366, 768], [1920, 1080], [800, 768], [390, 844]]);
});

test("недоступный трек и пустой разбор", async ({ page }) => {
  await page.goto("/sing/no-such-song");
  await expect(page.getByRole("alert")).toContainText("Эталон песни не найден");
  await page.goto("/result");
  await expect(page.getByRole("heading", { name: "Разбора пока нет." })).toBeVisible();
});

test("сервер недоступен: одиночное пение работает, кабинет объясняет", async ({ page }) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/account");
  await expect(page.getByText("Сервер кабинета недоступен")).toBeVisible();
  await page.goto("/songs");
  await expect(page.getByRole("button", { name: /Петь «/ })).toBeEnabled();
});

test("нет соперника: честное предложение без ботов и выдуманного онлайна", async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await player(browser, "Одиночка", "cn-earth", {});
  await a.page.goto("/duels");
  await a.page.getByRole("button", { name: "Найти соперника" }).click();
  await expect(a.page.getByText(/Пока никто не подходит/)).toBeVisible({ timeout: 40_000 });
  await expect(a.page.getByText(/ботов вместо людей здесь нет/)).toBeVisible();
  await expect(a.page.getByText(/онлайн|игроков в сети/i)).toHaveCount(0);
  await a.page.getByRole("button", { name: "Отменить поиск" }).click();
  await a.context.close();
});

test("клавиатура: Tab-порядок, видимый фокус, Пробел, Esc и Enter в диалоге", async ({ page, context }) => {
  await fakeMic(context, "cn-earth");
  await page.goto("/");
  // SvelteKit при запуске сбрасывает фокус в начало документа: ждём готовности страницы.
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Главная" })).toBeFocused();
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).toBe("solid");
  // Порядок: «Главная», «Песни», «Дуэли», «Лидеры», «Друзья», «Мой прогресс», поиск.
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => document.activeElement!.getAttribute("aria-label") || (document.activeElement as HTMLElement).textContent!.trim()));
  }
  expect(order).toEqual(["Песни", "Дуэли", "Лидеры", "Друзья", "Мой прогресс", "Поиск песни"]);
  await page.goto("/sing/cn-earth");
  await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Пение")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByText("Пауза", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Выйти из попытки?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/songs$/);
});

test("масштаб 200% и ширина 800 px: без горизонтальной прокрутки", async ({ page }) => {
  for (const url of ["/", "/songs", "/duels", "/leaders", "/account", "/progress", "/friends", "/sing/cn-earth"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    // 1366×768 при масштабе 200% — это 683×384 CSS-пикселя.
    for (const [w, h] of [[683, 384], [800, 768]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(150);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(sw, `${url} ${w}px`).toBeLessThanOrEqual(w);
    }
  }
  await page.setViewportSize({ width: 683, height: 384 });
  await page.goto("/");
  await page.screenshot({ path: "../docs/screens/home-zoom200.png", fullPage: true });
});
