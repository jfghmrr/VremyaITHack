import { expect, test } from "@playwright/test";
import { fakeMic } from "./fake-mic";
import { accepted, password } from "./helpers";
import { shoot } from "./shoot";

async function singOnce(page: import("@playwright/test").Page) {
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 40_000 });
}

test("кабинет: регистрация, история, изоляция двух аккаунтов, выход и вход", async ({ browser }) => {
  const ctxA = await browser.newContext({ permissions: ["microphone"], storageState: accepted() });
  await fakeMic(ctxA, "cn-earth", { shift: -5 });
  const a = await ctxA.newPage();
  await a.goto("/account");
  await shoot(a, "account-guest", [[1366, 768], [800, 768]]);
  await a.getByRole("tab", { name: "Регистрация" }).click();
  const email = `qa-ui-${Date.now()}@example.test`;
  await a.getByLabel("Имя в игре (видно другим игрокам)").fill("Дина");
  await a.getByLabel("Почта", { exact: true }).fill(email);
  await a.getByLabel("Пароль", { exact: true }).fill("short");
  await a.getByLabel("Мне 14 лет или больше").check();
  await a.getByLabel(/согласие на обработку/).check();
  await a.getByRole("button", { name: "Создать кабинет" }).click();
  // Браузерная проверка minlength не даёт отправить короткий пароль.
  await expect(a.getByRole("heading", { name: "Дина" })).toHaveCount(0);
  await a.getByLabel("Пароль", { exact: true }).fill(password);
  await a.getByRole("button", { name: "Создать кабинет" }).click();
  await expect(a.getByRole("heading", { name: "Дина" })).toBeVisible();
  await a.goto("/progress");
  await expect(a.getByRole("region", { name: "Мой прогресс", exact: true }).getByText("0 песен · 0 попыток")).toBeVisible();
  await a.getByRole("button", { name: "История исполнений" }).click();
  await expect(a.getByText("Здесь будут твои попытки и дуэли.")).toBeVisible();
  await singOnce(a);
  await a.goto("/progress");
  await a.getByRole("button", { name: "История исполнений" }).click();
  await expect(a.getByRole("region", { name: "Список попыток и матчей" }).getByText("Земное притяжение")).toBeVisible();
  await shoot(a, "account", [[1366, 768], [1920, 1080], [800, 768]]);
  // Таблица лидеров видна вошедшему игроку; до калибровки его места в ней нет.
  await a.goto("/leaders");
  await expect(a.getByRole("heading", { name: "Топ игроков" })).toBeVisible();
  await expect(a.getByRole("list", { name: "Места по рейтингу" }).or(a.getByText(/Пока никто не прошёл калибровку/))).toBeVisible();
  await shoot(a, "leaders", [[1366, 768]]);
  await a.goto("/progress");
  await a.getByRole("button", { name: "История исполнений" }).click();

  // Второй аккаунт не видит чужую историю.
  const ctxB = await browser.newContext({ storageState: accepted() });
  const b = await ctxB.newPage();
  await b.goto("/account");
  await b.getByRole("tab", { name: "Регистрация" }).click();
  await b.getByLabel("Имя в игре (видно другим игрокам)").fill("Егор");
  await b.getByLabel("Почта", { exact: true }).fill(`qa-ui2-${Date.now()}@example.test`);
  await b.getByLabel("Пароль", { exact: true }).fill(password);
  await b.getByLabel("Мне 14 лет или больше").check();
  await b.getByLabel(/согласие на обработку/).check();
  await b.getByRole("button", { name: "Создать кабинет" }).click();
  await expect(b.getByRole("heading", {name:"Егор"})).toBeVisible();
  await b.goto("/progress");
  await b.getByRole("button", { name: "История исполнений" }).click();
  await expect(b.getByText("Здесь будут твои попытки и дуэли.")).toBeVisible();

  // Выход и повторный вход.
  await a.goto("/account");
  await a.getByRole("button", { name: "Выйти из кабинета" }).click();
  await expect(a.getByRole("tab", { name: "Вход" })).toBeVisible();
  const anon = await a.evaluate(async () => (await fetch("/api/attempts")).status);
  expect(anon).toBe(401);
  await a.getByLabel("Почта", { exact: true }).fill(email.toUpperCase());
  await a.getByLabel("Пароль", { exact: true }).fill("Wrong-password-123");
  await a.getByRole("button", { name: "Войти" }).click();
  await expect(a.getByText("Неверная почта или пароль.")).toBeVisible();
  await a.getByLabel("Пароль", { exact: true }).fill(password);
  await a.getByRole("button", { name: "Войти" }).click();
  await expect(a.getByRole("heading", { name: "Дина" })).toBeVisible();
  await a.goto("/progress");
  await a.getByRole("button", {name:"История исполнений"}).click();
  await expect(a.getByRole("region", { name: "Список попыток и матчей" }).getByText("Земное притяжение")).toBeVisible();
  await ctxA.close();
  await ctxB.close();
});

test("вызов-призрак: ссылка открывается во втором браузере и даёт дуэль без рейтинга", async ({ browser }) => {
  const one = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"], storageState: accepted() });
  await fakeMic(one, "cn-earth", { shift: 3 });
  const p1 = await one.newPage();
  await singOnce(p1);
  await p1.getByLabel("Имя для вызова").fill("Саша");
  await p1.getByRole("button", { name: "Поделиться" }).click();
  const link = await p1.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain("/#echo=");

  const two = await browser.newContext({ permissions: ["microphone"], storageState: accepted() });
  await fakeMic(two, "cn-earth", { shift: -4, errors: [[300, 600, 1.8]] });
  const p2 = await two.newPage();
  await p2.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(p2.getByRole("heading", { name: /Саша вызывает тебя спеть «Земное притяжение»/ })).toBeVisible();
  await shoot(p2, "ghost-incoming", [[1366, 768]]);
  await p2.getByRole("button", { name: "Принять вызов" }).click();
  await expect(p2.getByText(/Против призрака: Саша/)).toBeVisible();
  await p2.getByRole("button", { name: "Включить микрофон" }).click();
  await p2.getByRole("button", { name: "Начать пение" }).click();
  await expect(p2).toHaveURL(/\/result$/, { timeout: 40_000 });
  await expect(p2.getByText("Дуэль с призраком: рейтинг не меняется")).toBeVisible({ timeout: 10_000 });
  await expect(p2.getByText(/Саша впереди|Ничья|Ты впереди/)).toBeVisible();

  // Повреждённая ссылка — понятное объяснение, без падения.
  await p2.goto("/#echo=AAAA");
  await expect(p2.getByRole("alert")).toContainText(/Вызов повреждён|Некорректная ссылка/);
  await one.close();
  await two.close();
});
