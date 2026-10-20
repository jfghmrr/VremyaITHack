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

test("одна нота всю песню (мычание): балл не выше 30", async ({ page, context }) => {
  await fakeMic(context, "cn-earth", { hum: 57 });
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page.getByLabel(/из 100/)).toBeVisible({ timeout: 40_000 });
  const label = await page.getByLabel(/из 100/).getAttribute("aria-label");
  expect(Number(label!.split(" ")[0])).toBeLessThanOrEqual(30);
  await page.getByRole("button", { name: "Разбор и ошибки" }).click();
  await expect(page.getByText("Почти одна нота всю попытку.")).toBeVisible();
});

test("тихий микрофон: голос слышен, сайт сообщает об усилении", async ({ page, context }) => {
  // Тон с RMS около 0.0057: ниже прежнего порога детектора 0.008 и ниже «нормального» уровня.
  await fakeMic(context, "cn-earth", { level: 0.008 });
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await expect(page.getByText("Голос слышен. Можно начинать.")).toBeVisible();
  await expect(page.getByText(/Уровень звука: тихий — для распознавания сайт усиливает его в \d,\d раза/)).toBeVisible();
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
  // Пояснение приходит от сервера («никто не ищет»); подсказка браузера — только без пояснения.
  await expect(a.page.getByText(/никто не ищет соперника|Пока никто не подходит/).first()).toBeVisible({ timeout: 40_000 });
  await expect(a.page.getByText(/ботов вместо людей здесь нет/)).toBeVisible({ timeout: 40_000 });
  await expect(a.page.getByText(/онлайн|игроков в сети/i)).toHaveCount(0);
  await a.page.getByRole("button", { name: "Отменить поиск" }).click();
  await a.context.close();
});

test("клавиатура: Tab-порядок, видимый фокус, Пробел, Esc и Enter в диалоге", async ({ page, context }) => {
  await fakeMic(context, "cn-earth");
  await page.goto("/");
  // SvelteKit при запуске сбрасывает фокус в начало документа: ждём готовности страницы.
  await page.waitForLoadState("networkidle");
  // Первая остановка — ссылка «К содержимому» (QA L27): в фокусе она видна.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "К содержимому" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport({ ratio: 1 });
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

// Ревью: на телефоне «Настройки звука» раскрыты сами, когда сохранённый микрофон не подключён.
// Выбор рабочего входа не должен сворачивать их под рукой; свернуть может только сама кнопка.
test.describe("телефон 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("сохранённый микрофон отключён: настройки звука раскрыты и не сворачиваются после выбора", async ({ page, context }) => {
    await fakeMic(context, "cn-earth");
    await page.addInitScript(() => localStorage.setItem("perepev.inputDeviceId", "unplugged"));
    await page.goto("/sing/cn-earth");
    const toggle = page.getByRole("button", { name: "Настройки звука" });
    const input = page.getByRole("combobox", { name: "Устройство ввода" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(input).toContainText("Сохранённый микрофон не подключён");
    await input.selectOption("");
    await page.waitForTimeout(200);
    await expect(input).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(input).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(input).toBeVisible();
  });
});
