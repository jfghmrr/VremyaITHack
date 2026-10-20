import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";
import { accepted, password } from "./helpers";
import { shoot } from "./shoot";
import type { CatalogEntry } from "../../src/lib/catalog";
import { documents } from "../../src/lib/legal/operator";
import { count, SECONDS } from "../../src/lib/ui/format";

const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL("../../static/songs/index.json", import.meta.url), "utf8"));

test("плашка cookie: видна новому посетителю, ведёт к документам и запоминает согласие", async ({ browser }) => {
  // Чистый профиль: без заранее принятого уведомления из конфигурации.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Уведомление о cookie" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("только необходимые cookie");
  await shoot(page, "cookie-banner", [[1366, 768], [800, 768]]);
  await banner.getByRole("link", { name: "Подробнее" }).click();
  await expect(page.getByRole("heading", { name: "Cookie и хранилище браузера" })).toBeVisible();
  await expect(page.getByText("perepev_session")).toBeVisible();
  await page.getByRole("button", { name: "Принимаю" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Cookie и хранилище браузера" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Уведомление о cookie" })).toHaveCount(0);
  await context.close();
});

test("документы: политика, отдельное согласие, cookie, музыка; ссылки в подвале", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  for (const name of ["Политика обработки данных", "Согласие на обработку данных", "Cookie", "Музыка и лицензии", "Пользовательское соглашение", "Контакты"])
    await expect(footer.getByRole("link", { name })).toBeVisible();
  await expect(footer.getByText("6+", { exact: true })).toBeVisible();
  await footer.getByRole("link", { name: "Политика обработки данных" }).click();
  await expect(page.getByRole("heading", { name: "Политика обработки персональных данных" })).toBeVisible();
  await expect(page.getByText("[не заполнено владельцем сайта]")).toHaveCount(0);
  await expect(page.getByText("Команда mugsize", { exact: true })).toBeVisible();
  await expect(page.getByText(/компьютере команды в России/).first()).toBeVisible();
  await expect(page.getByRole("link",{name:"Закрыть документы"})).toBeVisible();
  await expect(page.getByText("Удалить кабинет").first()).toBeVisible();
  await page.goto("/legal/consent");
  await expect(page.getByText("оформлено отдельно от иных документов")).toBeVisible();
  await expect(page.getByText(`Редакция от ${documents.consent}`)).toBeVisible();
  await page.goto("/legal/terms");
  await expect(page.getByRole("heading", { name: "Пользовательское соглашение" })).toBeVisible();
  await expect(page.getByText(/удаляется через 24 часа/).first()).toBeVisible();
  await expect(page.getByText(/есть права на загружаемый файл/).first()).toBeVisible();
  await page.goto("/legal/music");
  await expect(page.getByRole("link", { name: "Сведения о фрагменте", exact: true })).toHaveCount(catalog.length);
  await expect(page.getByRole("link", { name: "CC BY 4.0", exact: true }).first()).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
  await expect(page.getByRole("link", { name: "CC BY-SA 4.0", exact: true }).first()).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
  for (const language of ["ru", "en"]) {
    const song = catalog.find((entry) => entry.language === language)!;
    const credit = page.locator(`section[id="${song.id}"]`);
    await expect(credit.getByRole("heading", { name: song.title, exact: true })).toBeAttached();
    await expect(credit.getByRole("link", { name: "Сведения о фрагменте", exact: true })).toHaveAttribute("href", `/songs/${song.id}/CREDITS.json`);
  }
  await shoot(page, "legal-music", [[1366, 768]], true);
});

test("документы описывают настоящее поведение: запись голоса, сроки, хранилище браузера", async ({ page }) => {
  await page.goto("/legal/cookies");
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
  // Cookie гостя живёт сутки (Max-Age сервера) и лимитов не задаёт: лимиты считаются по адресу.
  await expect(row("perepev_guest")).toContainText("24 часа");
  await expect(row("perepev_guest")).not.toContainText("до очистки");
  await expect(row("perepev_guest")).not.toContainText("ограничивает");
  for (const key of ["perepev.voiceConsent", "perepev.playMode", "perepev.awards.sound"]) await expect(row(key)).toHaveCount(1);
  await expect(page.getByText(/только в памяти открытой вкладки/)).toHaveCount(0);
  await expect(page.getByText(/компьютере команды в России/).first()).toBeVisible();
  await page.goto("/legal/privacy");
  const terms = page.getByRole("listitem");
  await expect(terms.filter({ hasText: "итоги точной оценки" })).toContainText("24 часа");
  await expect(terms.filter({ hasText: /^обращения/ })).toContainText("один год");
  await expect(terms.filter({ hasText: "адрес IP" })).toContainText("не дольше часа");
  await page.goto("/legal/terms");
  await expect(page.getByText(/по 2 секунды до и после/)).toBeVisible();
});

test("каталог: разделы, новая песня, пение по ней", async ({ page, context }) => {
  const song = catalog.find((entry) => entry.id === "cn-earth")!;
  expect(song?.hasVocals).toBe(true);
  await fakeMic(context, song.id, { shift: 2 });
  await page.goto("/songs");
  const songs = page.getByRole("group", { name: "Песни" }).getByRole("radio");
  await expect(songs).toHaveCount(catalog.length);
  // Возрастная маркировка на каждой карточке: из поля age каталога, по умолчанию 0+.
  await expect(page.getByRole("group", { name: "Песни" }).getByRole("img", { name: /^Возрастная маркировка \d+\+$/ })).toHaveCount(catalog.length);
  await expect(page.getByRole("group", { name: "Песни" }).getByRole("img", { name: `Возрастная маркировка ${song.age ?? "0+"}` }).first()).toBeVisible();
  expect(catalog.length).toBeGreaterThanOrEqual(20);
  await page.getByRole("button", { name: "Русские", exact: true }).click();
  await expect(songs).toHaveCount(catalog.filter((entry) => entry.language === "ru").length);
  await page.getByRole("button", { name: "Английские", exact: true }).click();
  await expect(songs).toHaveCount(catalog.filter((entry) => entry.language === "en").length);
  await expect(page.getByText(song.title, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Русские", exact: true }).click();
  await page.getByRole("searchbox").fill(song.title);
  await expect(songs).toHaveCount(1);
  await page.getByRole("button", { name: `Петь «${song.title}»` }).click();
  await expect(page.getByRole("heading", {name:song.title,exact:true})).toBeVisible();
  // Длительность со склонением: «21 секунда», «23 секунды», «30 секунд».
  await expect(page.getByText(count(Math.round(song.duration_s), SECONDS), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 80_000 });
  const label = await page.getByLabel(/из 100/).getAttribute("aria-label");
  expect(Number(label!.split(" ")[0])).toBeGreaterThan(85);
});

test("кабинет: согласие при регистрации, выгрузка данных и удаление кабинета", async ({ browser }) => {
  const context = await browser.newContext({ storageState: accepted(), acceptDownloads: true });
  const page = await context.newPage();
  const email = `qa-del-${Date.now()}@example.test`;
  await page.goto("/account");
  await page.getByRole("tab", { name: "Регистрация" }).click();
  await expect(page.getByRole("link", { name: "согласие на обработку персональных данных" })).toHaveAttribute("href", "/legal/consent");
  await page.getByLabel("Имя в игре (видно другим игрокам)").fill("Удаляемый");
  await page.getByLabel("Почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByLabel("Мне 14 лет или больше").check();
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole("button", { name: "Создать кабинет" }).click();
  await expect(page.getByRole("heading", { name: "Удаляемый" })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Скачать мои данные" }).click()]);
  const data = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(data.profile.email).toBe(email);
  // Редакция согласия на сервере (CONSENT_VERSION) совпадает с документом на сайте.
  // Мягкая проверка: при расхождении остальные шаги удаления всё равно выполняются.
  expect.soft(data.consent.version).toBe(documents.consent);
  expect(data.consent.at).toBeTruthy();
  await page.getByLabel("Пароль для подтверждения").fill("Wrong-password-123");
  await page.getByRole("button", { name: "Удалить кабинет" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Удалить/ }).click();
  await expect(page.getByRole("alert")).toContainText("Пароль неверен");
  await page.getByLabel("Пароль для подтверждения").fill(password);
  await page.getByRole("button", { name: "Удалить кабинет" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Удалить/ }).click();
  await expect(page.getByText("Кабинет и все его данные удалены.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Вход" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверная почта или пароль.")).toBeVisible();
  await context.close();
});

test("регистрация младше 14 лет без имени родителя: понятная ошибка, запрос не отправляется", async ({ page }) => {
  const sent: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/register")) sent.push(r.method()); });
  await page.goto("/account");
  await page.getByRole("tab", { name: "Регистрация" }).click();
  await page.getByLabel("Имя в игре (видно другим игрокам)").fill("Маша");
  await page.getByLabel("Почта", { exact: true }).fill(`qa-kid-${Date.now()}@example.test`);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByLabel("Мне меньше 14 лет").check();
  await expect(page.getByLabel("Имя родителя или законного представителя")).toBeVisible();
  await page.getByLabel(/Родитель или законный представитель разрешает/).check();
  await page.getByRole("button", { name: "Создать кабинет" }).click();
  await expect(page.getByRole("alert")).toContainText("Укажи имя родителя или законного представителя");
  expect(sent).toEqual([]);
});

test("вход через Яндекс ID и VK ID: кнопки только для настроенных провайдеров, понятная ошибка возврата", async ({ page }) => {
  await page.goto("/account");
  await expect(page.getByRole("tab", { name: "Вход" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Войти через/ })).toHaveCount(0);
  await page.route("**/api/auth/providers", (r) => r.fulfill({ json: { providers: ["yandex", "vk"] } }));
  await page.goto("/account");
  const yandex = page.getByRole("link", { name: "Войти через Яндекс ID" });
  await expect(yandex).toHaveAttribute("href", "/api/auth/yandex/start?return=%2Faccount");
  await expect(page.getByRole("link", { name: "Войти через VK ID" })).toHaveAttribute("href", "/api/auth/vk/start?return=%2Faccount");
  expect((await yandex.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.goto("/account?authError=denied");
  await expect(page.getByRole("alert")).toContainText("Вход отменён");
  await page.goto("/account?authError=state");
  await expect(page.getByRole("alert")).toContainText("Ссылка для входа устарела");
});

test("вход через сервис возвращает туда, где он начался (свой трек), чужие адреса отбрасываются", async ({ page }) => {
  await page.route("**/api/auth/providers", (r) => r.fulfill({ json: { providers: ["yandex", "vk"] } }));
  await page.goto("/songs");
  const start = page.getByRole("link", { name: "Свой трек — после входа" });
  await expect(start).toHaveAttribute("href", "/account?return=%2Fsongs%23my-tracks");
  await start.click();
  await expect(page.getByRole("link", { name: "Войти через Яндекс ID" })).toHaveAttribute("href", "/api/auth/yandex/start?return=%2Fsongs%23my-tracks");
  await expect(page.getByRole("link", { name: "Войти через VK ID" })).toHaveAttribute("href", "/api/auth/vk/start?return=%2Fsongs%23my-tracks");
  for (const evil of ["//evil.test/x", "https://evil.test", "/api/me/delete", "/\\evil.test"]) {
    await page.goto(`/account?return=${encodeURIComponent(evil)}`);
    await expect(page.getByRole("link", { name: "Войти через Яндекс ID" })).toHaveAttribute("href", "/api/auth/yandex/start?return=%2Faccount");
  }
});

test("новый пользователь Яндекс ID: согласие и возраст, затем кабинет без пароля", async ({ page }) => {
  let sent: unknown = null;
  let profile: Record<string, unknown> | null = null;
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.route("**/api/auth/complete", async (r) => {
    sent = r.request().postDataJSON();
    profile = { id: "00000000-0000-4000-8000-000000000001", name: "Певец-4821", email: null, hasPassword: false, providers: ["yandex"] };
    await r.fulfill({ status: 201, json: { profile } });
  });
  await page.goto("/account?signup=tok-123");
  await expect(page.getByRole("heading", { name: "Завершение входа" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Регистрация" })).toHaveCount(0);
  await page.getByRole("button", { name: "Завершить вход" }).click();
  // Без согласия и возраста форма не отправляется.
  expect(sent).toBeNull();
  await page.getByLabel("Мне 14 лет или больше").check();
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole("button", { name: "Завершить вход" }).click();
  await expect(page.getByRole("heading", { name: "Певец-4821" })).toBeVisible();
  expect(sent).toEqual({ token: "tok-123", consent: true, ageGroup: "14plus", parentName: null });
  await expect(page).toHaveURL(/\/account$/);
  // Кабинет без почты и пароля: удаление подтверждается словом; пароль не задаётся — войти
  // по нему нельзя, а удаление потребовало бы его вместо слова.
  await expect(page.getByLabel("Пароль для подтверждения")).toHaveCount(0);
  await expect(page.getByLabel("Для подтверждения введи УДАЛИТЬ").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /пароль/i })).toHaveCount(0);
  await expect(page.getByLabel("Новый пароль")).toHaveCount(0);
  await expect(page.getByText("Ты входишь через Яндекс ID")).toBeVisible();
});

test("кабинет VK ID без почты: подпись сервиса VK ID, формы пароля нет", async ({ page }) => {
  let profile = { id: "00000000-0000-4000-8000-000000000003", name: "Певец-0042", email: null, hasPassword: false, providers: ["vk"] };
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Певец-0042" })).toBeVisible();
  await expect(page.getByText("Ты входишь через VK ID")).toBeVisible();
  await expect(page.getByText("Яндекс ID")).toHaveCount(0);
  await expect(page.getByLabel("Новый пароль")).toHaveCount(0);
  // Список сервисов не пришёл: подпись нейтральная, а не «Яндекс ID» по умолчанию.
  profile = { ...profile, providers: [] };
  await page.reload();
  await expect(page.getByRole("heading", { name: "Певец-0042" })).toBeVisible();
  await expect(page.getByText("Ты входишь через Яндекс ID или VK ID")).toBeVisible();
});

test("контакты: заглушка оператора и жалоба правообладателя", async ({ page }) => {
  let body: unknown = null;
  await page.route("**/api/complaints", async (r) => {
    body = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Контакты" }).click();
  await expect(page.getByRole("heading", { name: "Контакты" })).toBeVisible();
  await expect(page.getByText("Команда mugsize", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Ваше имя или организация").fill("ООО Правообладатель");
  await page.getByLabel("Почта для ответа").fill("rights@example.test");
  await page.getByLabel("Ссылка на материал").fill("https://perepev.lumnex.ru/sing/my-1");
  await page.getByLabel("Суть обращения").fill("Загружена запись без разрешения.");
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Заявка отправлена" })).toBeVisible();
  expect(body).toEqual({ name: "ООО Правообладатель", email: "rights@example.test", url: "https://perepev.lumnex.ru/sing/my-1", text: "Загружена запись без разрешения." });
});

test("контакты: обращение о данных без ссылки на материал", async ({ page }) => {
  let body: unknown = null;
  await page.route("**/api/complaints", async (r) => {
    body = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { ok: true } });
  });
  await page.goto("/legal/contacts");
  await expect(page.getByRole("heading", { name: "Обращение к оператору" })).toBeVisible();
  await page.getByLabel("Ваше имя или организация").fill("Иван Петров");
  await page.getByLabel("Почта для ответа").fill("ivan@example.test");
  await page.getByLabel("Суть обращения").fill("Отзываю согласие на обработку данных.");
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Заявка отправлена" })).toBeVisible();
  expect(body).toEqual({ name: "Иван Петров", email: "ivan@example.test", url: "", text: "Отзываю согласие на обработку данных." });
});
