import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const baseURL = process.env.ECHO_BASE_URL || "http://127.0.0.1:5173/";
const output = "docs/qa/identity";
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
  await page.waitForTimeout(200);
  await page.evaluate(() => document.fonts.ready);
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
  if (width >= 1366 && (await page.locator(".duel-view").count())) {
    const playback = await page.locator(".review-panel").boundingBox();
    for (const player of await page.locator(".battle-player").all()) {
      const box = await player.boundingBox();
      assert.ok(
        box.y + box.height <= playback.y - 8,
        "Duel panel overlaps playback",
      );
    }
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
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .waitFor();
  await sizes(page, "home");
  await page
    .getByRole("textbox", { name: "Твоё имя", exact: true })
    .fill("Аня");
  await page.keyboard.press("Space");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Твоё имя", exact: true })
      .inputValue(),
    "Аня ",
  );
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .click();
  await sizes(page, "microphone-before");
  await page.locator("body").click({ position: { x: 5, y: 100 } });
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  await page
    .getByRole("combobox", { name: "Устройство ввода", exact: true })
    .selectOption("usb-headset");
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("echo.inputDeviceId")),
    "usb-headset",
  );
  assert.equal(
    await page.evaluate(() => window.__micRequests.at(-1).audio.deviceId.exact),
    "usb-headset",
  );
  await page.locator(".mic-trace canvas").waitFor();
  await page.waitForTimeout(1000);
  await sizes(page, "microphone");
  await page.locator("body").click({ position: { x: 5, y: 100 } });
  await page.keyboard.press("Space");
  await page.waitForTimeout(4300);
  await page.keyboard.press("Space");
  await page.locator(".pause-overlay").waitFor();
  const before = await page.locator(".sing-status").innerText();
  await page.waitForTimeout(600);
  assert.equal(
    await page.locator(".sing-status").innerText(),
    before,
    "song clock advanced on pause",
  );
  await snap(page, "paused");
  await page.keyboard.press("Space");
  await sizes(page, "singing");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor();
  await snap(page, "exit-dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page
    .getByText("Твой результат", { exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await sizes(page, "result");
  assert.ok((await page.locator(".moment").count()) >= 2);
  assert.ok((await page.locator(".shift-pill").innerText()).includes("-5"));
  assert.ok(
    await page
      .locator(".moments-panel")
      .evaluate((e) => e.scrollHeight <= e.clientHeight),
    "moments require internal scroll",
  );
  await page
    .getByRole("button", { name: "Воспроизвести запись", exact: true })
    .click();
  await page.getByText("Слушаем попытку…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Идеальный я", exact: true }).click();
  await page
    .getByRole("button", { name: "Остановить запись", exact: true })
    .click();
  await page.getByLabel("Режим «идеального себя»").selectOption("voice");
  await page
    .getByRole("button", { name: "Воспроизвести запись", exact: true })
    .click();
  await page.getByText("Слушаем попытку…", { exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Как пел", exact: true }).click();
  await page
    .getByRole("button", { name: "Остановить запись", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переслушать", exact: true })
    .first()
    .click();
  await page.getByText("Переслушиваем момент 1…", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Остановить запись", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Скопировать ссылку-вызов", exact: true })
    .click();
  await page.getByText("Ссылка скопирована", { exact: true }).waitFor();
  const url = await page
    .getByRole("textbox", { name: "Ссылка-вызов", exact: true })
    .inputValue();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  await snap(page, "copied");
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page
    .getByRole("button", { name: "Скопировать ссылку-вызов", exact: true })
    .click();
  await page
    .getByText("Автокопирование недоступно. Выдели ссылку в поле ниже.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Ссылка-вызов", exact: true })
      .inputValue(),
    url,
  );

  await page.locator("body").click({ position: { x: 5, y: 100 } });
  await page.keyboard.press("r");
  await page
    .getByRole("combobox", { name: "Устройство ввода", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "Устройство ввода", exact: true })
      .inputValue(),
    "usb-headset",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .waitFor();
  console.log(
    "PASS: desktop screens, device selection, Space pause, Esc cancel, R retry, A/B, fragments, clipboard.",
  );
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
  await duel
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  await duel
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await duel.getByRole("button", { name: "Начать пение", exact: true }).click();
  await duel.waitForTimeout(4500);
  await sizes(duel, "ghost-singing");
  await duel
    .getByText("Дуэль завершена", { exact: true })
    .waitFor({ timeout: 30000 });
  await duel
    .getByRole("heading", { name: "Твоя победа", exact: true })
    .waitFor();
  await sizes(duel, "duel");
  await duel.getByRole("button", { name: "Мой разбор", exact: true }).click();
  await sizes(duel, "duel-review");
  await duel.keyboard.press("r");
  await duel
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await duel.getByRole("button", { name: "Начать пение", exact: true }).click();
  await duel.keyboard.press("Escape");
  await duel.getByRole("dialog").waitFor();
  await duel.keyboard.press("Enter");
  await duel
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .waitFor();
  console.log(
    "PASS: second tab, stored device, ghost, duel comparison, Enter confirms exit.",
  );
  for (const [code, text] of [
    ["NotAllowedError", "Нет доступа к микрофону"],
    ["NotFoundError", "Выбранный микрофон не найден"],
    ["NotReadableError", "Микрофон занят"],
  ]) {
    const denied = await browser.newContext();
    await denied.addInitScript((code) => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Test", code);
      };
    }, code);
    const p = await denied.newPage();
    await p.goto(baseURL);
    await p
      .getByRole("button", { name: "Начать пение", exact: true })
      .first()
      .click();
    await p
      .getByRole("button", { name: "Включить микрофон", exact: true })
      .click();
    await p.getByRole("alert").filter({ hasText: text }).waitFor();
    await denied.close();
  }
  const quietContext = await browser.newContext();
  await quietContext.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const source = ctx.createConstantSource();
      source.offset.value = 0;
      source.connect(dest);
      source.start();
      return dest.stream;
    };
  });
  const quiet = await quietContext.newPage();
  await quiet.goto(baseURL);
  await quiet
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .click();
  await quiet
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await quiet
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  await quiet.waitForTimeout(400);
  assert.equal(
    await quiet.getByRole("meter").getAttribute("aria-valuenow"),
    "0",
  );
  await quiet
    .getByText(
      "Ничего не слышно. Проверьте, что выбран нужный микрофон, и попробуйте спеть громче.",
      { exact: true },
    )
    .waitFor();
  await quietContext.close();
  console.log("PASS: silent input and clipboard rejection fallback.");
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/checks.json`,
    JSON.stringify(
      { browser: await browser.version(), checks, errors },
      null,
      2,
    ),
  );
  console.log(
    `PASS: device error paths. ${checks.length} viewport checks. Browser: ${await browser.version()}`,
  );
} finally {
  await browser.close();
}
