import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const baseURL = process.env.ECHO_BASE_URL || "http://127.0.0.1:5173/";
const output = process.env.ECHO_QA_OUTPUT || "docs/qa/perepev";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.ECHO_BROWSER || "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const errors = [],
  checks = [];
const reference = JSON.parse(
  await readFile("public/songs/ode/reference.json", "utf8"),
).f0_midi;
async function fixture(context) {
  await context.addInitScript(
    ({ reference }) => {
      let input = null,
        granted = false;
      window.__micRequests = [];
      const suspend = AudioContext.prototype.suspend,
        resume = AudioContext.prototype.resume;
      AudioContext.prototype.suspend = async function () {
        await suspend.call(this);
        if (input && input.ctx !== this && input.scheduled)
          await suspend.call(input.ctx);
      };
      AudioContext.prototype.resume = async function () {
        await resume.call(this);
        if (
          input &&
          input.ctx !== this &&
          input.scheduled &&
          input.ctx.state === "suspended"
        )
          await resume.call(input.ctx);
      };
      navigator.mediaDevices.enumerateDevices = async () =>
        ["built-in", "usb-headset"].map((id, i) => ({
          kind: "audioinput",
          deviceId: id,
          groupId: id,
          label: granted ? ["Встроенный микрофон", "USB-гарнитура"][i] : "",
        }));
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.__micRequests.push(constraints);
        granted = true;
        const selected = constraints.audio?.deviceId?.exact;
        if (selected && !["built-in", "usb-headset"].includes(selected))
          throw new DOMException("Missing", "NotFoundError");
        if (input) await input.ctx.close();
        const ctx = new AudioContext();
        await resume.call(ctx);
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator(),
          gain = ctx.createGain();
        osc.frequency.value = 220;
        gain.gain.value = 0.18;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        input = { ctx, osc, gain, scheduled: false };
        return dest.stream;
      };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when = 0, ...args) {
        if (
          input &&
          !input.scheduled &&
          this.buffer &&
          Math.abs(this.buffer.duration - 20) < 0.2
        ) {
          const f = input;
          f.scheduled = true;
          const base = f.ctx.currentTime + (when - this.context.currentTime);
          f.gain.gain.setValueAtTime(0, f.ctx.currentTime);
          reference.forEach((m, i) => {
            const t = base + i * 0.01;
            f.gain.gain.setValueAtTime(m === null ? 0 : 0.22, t);
            if (m !== null)
              f.osc.frequency.setValueAtTime(
                440 *
                  2 **
                    ((m -
                      5 +
                      ((i > 200 && i < 290) ||
                      (i > 500 && i < 610) ||
                      (i > 1100 && i < 1210)
                        ? window.__perfect
                          ? 0
                          : 2
                        : 0) -
                      69) /
                      12),
                t,
              );
          });
          f.gain.gain.setValueAtTime(0, base + 20);
        }
        return start.call(this, when, ...args);
      };
    },
    { reference },
  );
}
async function snap(page, name, width = 1366, height = 768) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(160);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  await page.screenshot({
    path: `${output}/${name}-${width}.png`,
    fullPage: true,
  });
  assert.ok(
    layout.scrollWidth <= width,
    `${name}: horizontal overflow ${JSON.stringify(layout)}`,
  );
  if (width >= 1366)
    assert.ok(
      layout.scrollHeight <= height,
      `${name}: vertical overflow ${JSON.stringify(layout)}`,
    );
  if (name === "duel-result" && width >= 1366) {
    const bounds = await page.evaluate(() => ({
      battle: document.querySelector(".battle-grid").getBoundingClientRect()
        .bottom,
      controls: document.querySelector(".review-panel").getBoundingClientRect()
        .top,
    }));
    assert.ok(
      bounds.battle <= bounds.controls - 8,
      `Duel overlaps playback: ${JSON.stringify(bounds)}`,
    );
  }
  checks.push({ screen: name, ...layout });
}
async function sizes(page, name) {
  await snap(page, name);
  await snap(page, name, 1920, 1080);
  await snap(page, name, 800, 768);
  await page.setViewportSize({ width: 1366, height: 768 });
}
function observe(page) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}
async function choose(page) {
  await page
    .getByRole("button", { name: "Спеть", exact: true })
    .first()
    .click();
  await page.locator(".detail-page").waitFor();
  await page.getByRole("button", { name: "Проверить микрофон" }).click();
}
try {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    permissions: ["microphone", "clipboard-read", "clipboard-write"],
  });
  await fixture(context);
  const page = await context.newPage();
  observe(page);
  await page.goto(baseURL);
  await page
    .getByRole("button", { name: "Спеть", exact: true })
    .first()
    .waitFor();
  await sizes(page, "catalog");
  await page.getByRole("searchbox").fill("несуществующая");
  await page.getByText("Такой мелодии пока нет").waitFor();
  await snap(page, "empty-search");
  await page.getByRole("button", { name: "Сбросить поиск" }).click();
  await page.getByRole("button", { name: "Регистрация", exact: true }).click();
  await sizes(page, "registration");
  await page.getByRole("textbox", { name: "Твоё имя" }).fill("Аня");
  await page
    .getByRole("button", { name: "Создать профиль", exact: true })
    .click();
  await page.getByRole("alert").filter({ hasText: "Подтверди" }).waitFor();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Создать профиль", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Мой профиль", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Мой профиль", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Твоё имя" }).inputValue(),
    "Аня",
  );
  await page.getByRole("button", { name: "Мой прогресс", exact: true }).click();
  await page.getByRole("heading", { name: "Пока нет результатов" }).waitFor();
  await sizes(page, "empty-progress");
  await page.getByRole("button", { name: "Дуэли", exact: true }).click();
  await sizes(page, "duel-lobby");
  await page.getByRole("button", { name: "Петь", exact: true }).click();
  await page
    .getByRole("button", { name: "Спеть", exact: true })
    .first()
    .click();
  await page.locator(".detail-page").waitFor();
  await sizes(page, "detail");
  await page.getByRole("button", { name: "Послушать эталон" }).click();
  await page.getByRole("button", { name: "Остановить эталон" }).click();
  await page.getByRole("button", { name: "Проверить микрофон" }).click();
  await sizes(page, "microphone-before");
  await page
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  await page
    .getByRole("combobox", { name: "Устройство ввода", exact: true })
    .selectOption("usb-headset");
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  await page.waitForTimeout(800);
  await sizes(page, "microphone");
  assert.equal(
    await page.evaluate(() => window.__micRequests.at(-1).audio.deviceId.exact),
    "usb-headset",
  );
  await page.getByRole("button", { name: "Начать пение", exact: true }).click();
  await page.waitForTimeout(5000);
  await page.locator("body").click({ position: { x: 5, y: 100 } });
  await page.keyboard.press("Space");
  await page.locator(".pause-overlay").waitFor();
  const clock = await page.locator(".sing-status").innerText();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".sing-status").innerText(), clock);
  await snap(page, "paused");
  await page.keyboard.press("Space");
  await sizes(page, "singing");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor();
  await snap(page, "exit-dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator(".result-screen").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await sizes(page, "result");
  assert.ok((await page.locator(".shift-pill").innerText()).includes("-5"));
  assert.ok(
    await page
      .locator(".moments-panel")
      .evaluate((e) => e.scrollHeight <= e.clientHeight),
    "moments scroll",
  );
  const pixels = () =>
    page.locator(".timeline-panel canvas").evaluate((c) => c.toDataURL());
  const a = await pixels();
  await page.getByRole("button", { name: "Воспроизвести запись" }).click();
  await page.getByText("Слушаем попытку…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Идеальный я", exact: true }).click();
  await page.waitForTimeout(650);
  assert.notEqual(await pixels(), a);
  await snap(page, "ideal-b");
  await page.getByRole("button", { name: "Остановить запись" }).click();
  await page.getByLabel("Режим «идеального себя»").selectOption("voice");
  await page.getByRole("button", { name: "Воспроизвести запись" }).click();
  await page.getByText("Слушаем попытку…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Остановить запись" }).click();
  await page.getByRole("button", { name: "Как пел", exact: true }).click();
  await page
    .getByRole("button", { name: "Переслушать", exact: true })
    .first()
    .click();
  await page.getByText("Переслушиваем момент 1…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Остановить запись" }).click();
  await page
    .getByRole("button", { name: "Повторить фрагмент", exact: true })
    .first()
    .click();
  await page.locator(".practice-page").waitFor();
  await sizes(page, "practice");
  await page
    .getByRole("button", { name: "Повторить фрагмент", exact: true })
    .click();
  await page.getByRole("button", { name: "Остановить", exact: true }).waitFor();
  await page.waitForTimeout(3500);
  await snap(page, "practice-live");
  await page.getByRole("button", { name: "К разбору" }).click();
  await page.locator(".result-screen").waitFor();
  await page
    .getByRole("button", { name: "Скопировать ссылку-вызов", exact: true })
    .click();
  await page.getByText("Ссылка скопирована", { exact: true }).waitFor();
  const url = await page
    .getByRole("textbox", { name: "Ссылка-вызов", exact: true })
    .inputValue();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  await snap(page, "copied");
  await page.getByRole("button", { name: "Мой прогресс", exact: true }).click();
  await page.getByText("Дубль 1", { exact: true }).first().waitFor();
  await sizes(page, "progress");
  await page.getByRole("button", { name: "Разобрать", exact: true }).click();
  await page
    .getByText("Это сохранённый разбор. Аудиозаписи в истории нет.")
    .waitFor();
  await snap(page, "history-detail");
  await page.getByRole("button", { name: "Рейтинг", exact: true }).click();
  await sizes(page, "ranking");
  const duel = await context.newPage();
  observe(duel);
  await duel.addInitScript(() => {
    window.__perfect = true;
  });
  await duel.goto(url);
  await duel
    .getByRole("button", { name: "Принять вызов", exact: true })
    .waitFor();
  await sizes(duel, "challenge");
  await duel.getByRole("button", { name: "Дуэли", exact: true }).click();
  await sizes(duel, "invitation");
  await duel
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  await duel
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await duel.getByRole("button", { name: "Начать пение", exact: true }).click();
  await duel.waitForTimeout(5000);
  await sizes(duel, "ghost-singing");
  await duel
    .getByText("Дуэль завершена", { exact: true })
    .waitFor({ timeout: 30000 });
  await sizes(duel, "duel-result");
  await duel
    .getByRole("heading", { name: "Твоя победа", exact: true })
    .waitFor();
  await duel.getByRole("button", { name: "Мой разбор", exact: true }).click();
  await sizes(duel, "duel-review");
  await duel.locator("body").click({ position: { x: 5, y: 100 } });
  await duel.keyboard.press("r");
  await duel
    .getByRole("combobox", { name: "Устройство ввода", exact: true })
    .waitFor();
  await duel.keyboard.press("Escape");
  await duel.getByRole("button", { name: "Мой профиль", exact: true }).click();
  await sizes(duel, "profile");
  await duel
    .getByRole("button", { name: "Выйти из профиля", exact: true })
    .click();
  await duel
    .getByRole("button", { name: "Регистрация", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Регистрация", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Рейтинг", exact: true }).click();
  assert.ok(
    (await page.locator(".history-row:not(.table-head)").count()) > 0,
    "history not persisted",
  );
  for (const [code, text] of [
    ["NotAllowedError", "Нет доступа к микрофону"],
    ["NotFoundError", "Выбранный микрофон не найден"],
    ["NotReadableError", "Микрофон занят"],
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    await ctx.addInitScript((code) => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Test", code);
      };
    }, code);
    const p = await ctx.newPage();
    await p.goto(baseURL);
    await choose(p);
    await p
      .getByRole("button", { name: "Включить микрофон", exact: true })
      .click();
    await p.getByRole("alert").filter({ hasText: text }).waitFor();
    await snap(p, code);
    await ctx.close();
  }
  await page.goto(baseURL);
  await snap(page, "catalog-small", 390, 844);
  await page.getByRole("button", { name: "Регистрация", exact: true }).click();
  await snap(page, "registration-small", 390, 844);
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/checks.json`,
    JSON.stringify(
      {
        browser: await browser.version(),
        checks,
        errors,
        profilePersistence: true,
        realAudioPipelineWithSyntheticInput: true,
        practice: true,
        history: true,
        ab: true,
        duel: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${checks.length} layout states, registration, audio pipeline, practice, A/B, clipboard, duel, history, errors.`,
  );
} finally {
  await browser.close();
}
