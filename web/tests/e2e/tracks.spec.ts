// Свой трек на заглушках /api/tracks (контракт C3): выбор отрывка по волне, загрузка WAV
// только выбранного куска, этапы обработки, удаление и пение готового трека /sing/my-<uuid>.
// Ошибки файла показываются до любой загрузки.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";

const UUID = "5f0c2b8e-7d1a-4c3b-9e6f-1a2b3c4d5e6f";
const OLD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const songFile = (name: string) => readFileSync(new URL(`../../static/songs/cn-earth/${name}`, import.meta.url));
const profile = { id: "00000000-0000-4000-8000-000000000002", name: "Певец-1234", email: null, hasPassword: false, providers: ["yandex"] };

function wavHeader(rate: number, bits: 8 | 16, dataBytes: number) {
  const out = Buffer.alloc(44);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE((rate * bits) / 8, 28);
  out.writeUInt16LE(bits / 8, 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  return out;
}

/** WAV 44,1 кГц моно PCM16 с синусом 220 Гц. */
function sineWav(seconds: number) {
  const n = Math.round(seconds * 44100);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 220 * i) / 44100)), 2 * i);
  return Buffer.concat([wavHeader(44100, 16, data.length), data]);
}

/** Длинный, но лёгкий файл: тишина 8 кГц, 8 бит (около 5 МБ на 11 минут). */
function longQuietWav(seconds: number) {
  const data = Buffer.alloc(seconds * 8000, 128);
  return Buffer.concat([wavHeader(8000, 8, data.length), data]);
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000 - 60_000).toISOString();

/** Заглушка /api/tracks: после загрузки каждый опрос списка продвигает трек на этап дальше. */
async function mockTracks(page: Page) {
  const log = { created: [] as unknown[], audio: [] as Buffer[], deleted: [] as string[], fileRequests: [] as string[] };
  const stages = [
    { status: "queued", stage: null },
    { status: "offline", stage: null },
    { status: "running", stage: "separating" },
    { status: "running", stage: "melody" },
    { status: "running", stage: "words" },
    { status: "ready", stage: null },
  ];
  let step = -1;
  const old = { id: OLD, title: "Старый трек", language: "en", status: "failed", stage: null, error: "Не удалось отделить голос.", expiresAt: hoursFromNow(5) };
  let deletedOld = false;
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/tracks") {
      const list: unknown[] = deletedOld ? [] : [old];
      if (step >= 0) {
        const s = stages[Math.min(step++, stages.length - 1)];
        list.unshift({ id: UUID, title: "Моя песня", language: "ru", error: null, expiresAt: hoursFromNow(24), ...s });
      }
      return route.fulfill({ json: { tracks: list } });
    }
    if (method === "POST" && path === "/api/tracks") {
      expect(request.headers()["x-perepev-request"]).toBe("1");
      log.created.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { id: UUID } });
    }
    if (method === "PUT" && path === `/api/tracks/${UUID}/audio`) {
      expect(request.headers()["content-type"]).toBe("audio/wav");
      log.audio.push(request.postDataBuffer()!);
      step = 0;
      return route.fulfill({ status: 202, json: {} });
    }
    if (method === "DELETE" && path === `/api/tracks/${OLD}`) {
      log.deleted.push(OLD);
      deletedOld = true;
      return route.fulfill({ status: 204 });
    }
    const file = new RegExp(`^/api/tracks/${UUID}/files/(.+)$`).exec(path);
    if (method === "GET" && file) {
      log.fileRequests.push(file[1]);
      const source = file[1].endsWith(".mp3") ? "backing.mp3" : file[1];
      return route.fulfill({ body: songFile(source), contentType: file[1].endsWith(".mp3") ? "audio/mpeg" : "application/json" });
    }
    return route.fulfill({ status: 404, json: { error: "Нет такого трека." } });
  });
  return log;
}

test("свой трек: волна и отрывок, загрузка только выбранного куска, этапы обработки, удаление, пение", async ({ page, context }) => {
  await fakeMic(context, "cn-earth");
  const log = await mockTracks(page);
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  await expect(mine).toBeVisible();
  await expect(page.getByRole("link", { name: /Мои треки/ })).toHaveAttribute("href", "#my-tracks");
  const old = mine.getByRole("listitem").filter({ hasText: "Старый трек" });
  await expect(old).toContainText("Не получилось");
  await expect(old).toContainText("удалится через 5 ч");

  await mine.getByLabel("Файл с песней").setInputFiles({ name: "Моя песня.wav", mimeType: "audio/wav", buffer: sineWav(40) });
  await expect(mine.getByRole("img", { name: /Звуковая волна/ })).toBeVisible();
  await expect(mine.getByText("0:00–0:30 · 30 с")).toBeVisible();
  await expect(mine.getByLabel("Название")).toHaveValue("Моя песня");
  // Окно тянется по волне: за правый край — короче, за середину — сдвиг.
  const wave = mine.locator(".wave canvas");
  await wave.scrollIntoViewIfNeeded();
  const box = (await wave.boundingBox())!;
  const y = box.y + box.height / 2;
  const startInput = mine.getByLabel("Начало отрывка");
  const lengthInput = mine.getByLabel("Длина отрывка");
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await lengthInput.inputValue())).toBeCloseTo(20, 0);
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.375, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await startInput.inputValue())).toBeCloseTo(5, 0);
  expect(Number(await lengthInput.inputValue())).toBeCloseTo(20, 0);
  await lengthInput.fill("30");
  await startInput.fill("5");
  await expect(mine.getByText("0:05–0:35 · 30 с")).toBeVisible();
  await mine.getByLabel("Язык песни").selectOption("en");
  await mine.getByRole("button", { name: "Загрузить отрывок" }).click();

  await expect(mine.getByText("В очереди")).toBeVisible();
  expect(log.created).toEqual([{ title: "Моя песня", language: "en" }]);
  // Только окно 30 с плюс поля по 2 с: (30 + 4) × 44100 × 2 + 44 байта, а не весь файл.
  expect(log.audio).toHaveLength(1);
  expect(log.audio[0].byteLength).toBe((30 + 4) * 44100 * 2 + 44);
  expect(log.audio[0].subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(log.audio[0].subarray(8, 12).toString("ascii")).toBe("WAVE");
  const mineItem = mine.getByRole("listitem").filter({ hasText: "Моя песня" });
  await expect(mineItem).toContainText("удалится через 24 ч");
  for (const text of ["ПК обработки выключен — ждём", "Отделяем голос", "Мелодия", "Слова"]) await expect(mineItem).toContainText(text, { timeout: 8000 });
  const sing = mineItem.getByRole("link", { name: "Готово — петь" });
  await expect(sing).toBeVisible({ timeout: 8000 });

  await old.getByRole("button", { name: "Удалить «Старый трек»" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
  await expect(old).toHaveCount(0);
  expect(log.deleted).toEqual([OLD]);

  await sing.click();
  await expect(page).toHaveURL(new RegExp(`/sing/my-${UUID}$`));
  await expect(page.getByRole("heading", { name: "Проверка микрофона" })).toBeVisible();
  await page.getByRole("button", { name: "Включить микрофон", exact: true }).click();
  await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
  expect(log.fileRequests).toEqual(expect.arrayContaining(["reference.json", "lyrics.words.json", "instrumental.mp3", "guide.mp3"]));
});

test("свой трек: нечитаемый, короткий, слишком длинный и слишком большой файл — понятная ошибка до загрузки", async ({ page }) => {
  const log = await mockTracks(page);
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  const file = mine.getByLabel("Файл с песней");
  const upload = mine.getByRole("button", { name: "Загрузить отрывок" });

  await file.setInputFiles({ name: "песня.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("Это текстовый файл, а не музыка.\n".repeat(200)) });
  await expect(mine.getByRole("alert")).toContainText("Не удалось прочитать аудио");
  await expect(upload).toHaveCount(0);

  await file.setInputFiles({ name: "коротко.wav", mimeType: "audio/wav", buffer: sineWav(10) });
  await expect(mine.getByRole("alert")).toContainText("Нужен отрывок от 15 секунд");
  await expect(upload).toHaveCount(0);

  // Длинный файл отклоняется по длительности из заголовка, без раскодирования.
  await file.setInputFiles({ name: "концерт.wav", mimeType: "audio/wav", buffer: longQuietWav(11 * 60) });
  await expect(mine.getByRole("alert")).toContainText("Файл длиннее 10 минут");
  await expect(upload).toHaveCount(0);

  // Трёхчасовая запись не проходит уже по размеру: проверка до чтения файла.
  await file.setInputFiles({ name: "три часа.mp3", mimeType: "audio/mpeg", buffer: Buffer.alloc(31 * 1024 * 1024) });
  await expect(mine.getByRole("alert")).toContainText("Файл больше 30 МБ");
  await expect(upload).toHaveCount(0);

  expect(log.created).toEqual([]);
  expect(log.audio).toEqual([]);
});

test("свой трек у гостя: раздела нет, есть подсказка войти", async ({ page }) => {
  await page.goto("/songs");
  await expect(page.getByRole("region", { name: "Мои треки" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Свой трек — после входа" })).toHaveAttribute("href", "/account?return=%2Fsongs%23my-tracks");
});

test("свой трек: браузер не сообщает длительность — длинный файл всё равно отклоняется до загрузки", async ({ page, context }) => {
  await context.addInitScript(() => {
    const w = window as unknown as { __decodes: number; __fakeLong: boolean };
    w.__decodes = 0;
    w.__fakeLong = false;
    // Как iOS Safari: для blob-адреса не приходят ни loadedmetadata, ни error.
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      ...src,
      set(this: HTMLMediaElement, value: string) {
        if (!String(value).startsWith("blob:")) src.set!.call(this, value);
      },
    });
    const decode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, data: ArrayBuffer) {
      w.__decodes++;
      // Формат без длительности в заголовке: раскодированный звук на 11 минут.
      if (w.__fakeLong) return Promise.resolve(new AudioBuffer({ length: 11 * 60 * 8000, sampleRate: 8000, numberOfChannels: 1 }));
      return decode.call(this, data);
    } as typeof decode;
  });
  const log = await mockTracks(page);
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  const file = mine.getByLabel("Файл с песней");
  const decodes = () => page.evaluate(() => (window as unknown as { __decodes: number }).__decodes);

  // Длительность из заголовка WAV: отказ без раскодирования и без ожидания <audio>.
  await file.setInputFiles({ name: "концерт.wav", mimeType: "audio/wav", buffer: longQuietWav(11 * 60) });
  await expect(mine.getByRole("alert")).toContainText("Файл длиннее 10 минут");
  expect(await decodes()).toBe(0);

  // Заголовок не разобран и <audio> молчит: длительность проверяется после раскодирования.
  await page.evaluate(() => ((window as unknown as { __fakeLong: boolean }).__fakeLong = true));
  await file.setInputFiles({ name: "длинный.m4a", mimeType: "audio/mp4", buffer: Buffer.from("неизвестный формат ".repeat(500)) });
  await expect.poll(decodes, { timeout: 10_000 }).toBe(1);
  await expect(mine.getByRole("alert")).toContainText("Файл длиннее 10 минут");
  await expect(mine.getByRole("button", { name: "Загрузить отрывок" })).toHaveCount(0);

  // Обычный файл с молчащим <audio> по-прежнему открывается.
  await page.evaluate(() => ((window as unknown as { __fakeLong: boolean }).__fakeLong = false));
  await file.setInputFiles({ name: "песня.wav", mimeType: "audio/wav", buffer: sineWav(20) });
  await expect(mine.getByRole("img", { name: /Звуковая волна/ })).toBeVisible();
  expect(log.created).toEqual([]);
  expect(log.audio).toEqual([]);
});

test("свой трек: сбой отправки звука — повтор без второго трека, брошенный трек удаляется", async ({ page }) => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const log = { posts: [] as string[], puts: [] as string[], deletes: [] as string[] };
  let failNext = true;
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/tracks") return route.fulfill({ json: { tracks: [] } });
    if (request.method() === "POST" && path === "/api/tracks") {
      const id = ids[log.posts.length];
      log.posts.push(id);
      return route.fulfill({ status: 201, json: { id } });
    }
    const audio = /^\/api\/tracks\/([^/]+)\/audio$/.exec(path);
    if (request.method() === "PUT" && audio) {
      log.puts.push(audio[1]);
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 503, json: { error: "Сервер занят, попробуй ещё раз." } });
      }
      return route.fulfill({ status: 202, json: {} });
    }
    const one = /^\/api\/tracks\/([^/]+)$/.exec(path);
    if (request.method() === "DELETE" && one) {
      log.deletes.push(one[1]);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  const file = mine.getByLabel("Файл с песней");
  const upload = mine.getByRole("button", { name: "Загрузить отрывок" });

  await file.setInputFiles({ name: "первая.wav", mimeType: "audio/wav", buffer: sineWav(20) });
  await upload.click();
  await expect(mine.getByRole("alert")).toContainText("Сервер занят");
  // Трек уже создан: название и язык не меняются, повтор отправляет только звук.
  await expect(mine.getByLabel("Название")).toBeDisabled();
  await upload.click();
  await expect(mine.getByText("Отрывок загружен")).toBeVisible();
  expect(log.posts).toEqual([ids[0]]);
  expect(log.puts).toEqual([ids[0], ids[0]]);

  // Снова сбой, но пользователь выбирает другой файл: созданный трек без звука удаляется.
  failNext = true;
  await file.setInputFiles({ name: "вторая.wav", mimeType: "audio/wav", buffer: sineWav(20) });
  await upload.click();
  await expect(mine.getByRole("alert")).toContainText("Сервер занят");
  await file.setInputFiles({ name: "третья.wav", mimeType: "audio/wav", buffer: sineWav(20) });
  await expect.poll(() => log.deletes).toEqual([ids[1]]);
  expect(log.posts).toEqual(ids);
});

test("свой трек: уход со страницы во время отправки звука не удаляет трек; сбой после ухода — удаляет", async ({ page }) => {
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  const log = { posts: [] as string[], puts: [] as string[], deletes: [] as string[] };
  const held: ((status: number) => void)[] = [];
  await page.route("**/api/me", (r) => r.fulfill({ json: { profile } }));
  await page.route(/\/api\/tracks(\/|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/tracks") return route.fulfill({ json: { tracks: [] } });
    if (request.method() === "POST" && path === "/api/tracks") {
      const id = ids[log.posts.length];
      log.posts.push(id);
      return route.fulfill({ status: 201, json: { id } });
    }
    const audio = /^\/api\/tracks\/([^/]+)\/audio$/.exec(path);
    if (request.method() === "PUT" && audio) {
      log.puts.push(audio[1]);
      // Медленная сеть телефона: ответ придёт, когда тест его отпустит.
      const status = await new Promise<number>((release) => held.push(release));
      return route.fulfill(status === 202 ? { status, json: {} } : { status, json: { error: "Сервер занят, попробуй ещё раз." } });
    }
    const one = /^\/api\/tracks\/([^/]+)$/.exec(path);
    if (request.method() === "DELETE" && one) {
      log.deletes.push(one[1]);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const nav = page.getByRole("navigation", { name: "Основная навигация" });
  for (const [i, status] of [[0, 202], [1, 503]] as const) {
    await page.goto("/songs");
    const mine = page.getByRole("region", { name: "Мои треки" });
    await mine.getByLabel("Файл с песней").setInputFiles({ name: "песня.wav", mimeType: "audio/wav", buffer: sineWav(20) });
    await mine.getByRole("button", { name: "Загрузить отрывок" }).click();
    await expect.poll(() => log.puts.length).toBe(i + 1);
    // Уход внутри приложения: страница песен закрывается, отправка продолжается.
    await nav.getByRole("link", { name: "Главная", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.waitForTimeout(300);
    expect(log.deletes).toEqual([]);
    held.shift()!(status);
    if (status === 202) {
      await page.waitForTimeout(500);
      expect(log.deletes).toEqual([]);
    } else await expect.poll(() => log.deletes).toEqual([ids[1]]);
  }
  expect(log.posts).toEqual(ids);
});

test("свой трек: ошибка чтения файла браузером — сообщение по-русски", async ({ page, context }) => {
  await context.addInitScript(() => {
    Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException("The requested file could not be read.", "NotReadableError"));
  });
  await mockTracks(page);
  await page.goto("/songs");
  const mine = page.getByRole("region", { name: "Мои треки" });
  await mine.getByLabel("Файл с песней").setInputFiles({ name: "песня.wav", mimeType: "audio/wav", buffer: sineWav(20) });
  await expect(mine.getByRole("alert")).toContainText("Не удалось прочитать аудио");
  await expect(mine.getByRole("alert")).not.toContainText("could not be read");
});
