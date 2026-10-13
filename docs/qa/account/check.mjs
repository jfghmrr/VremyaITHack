import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const baseURL = process.env.ECHO_BASE_URL || "http://localhost:8080/";
const output = "docs/qa/account";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream"],
});
const errors = [],
  checks = [];
const account = {
  email: `qa-${Date.now()}@example.test`,
  name: "Аня",
  password: "Demo-account-pass-2026",
};
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
async function snap(page, name, w = 1366, h = 768) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
  const box = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    sw: document.documentElement.scrollWidth,
    sh: document.documentElement.scrollHeight,
  }));
  await page.screenshot({ path: `${output}/${name}-${w}.png`, fullPage: true });
  assert.ok(box.sw <= w, `${name}: horizontal overflow`);
  if (w >= 1366) assert.ok(box.sh <= h, `${name}: vertical overflow ${box.sh}`);
  checks.push({ name, ...box });
}
async function sizes(p, n) {
  await snap(p, n);
  await snap(p, n, 1920, 1080);
  await snap(p, n, 800, 768);
  await p.setViewportSize({ width: 1366, height: 768 });
}
async function register(p, values) {
  await p.getByRole("button", { name: "Кабинет", exact: true }).click();
  await p.getByRole("button", { name: "Регистрация", exact: true }).click();
  await p.getByRole("textbox", { name: "Имя", exact: true }).fill(values.name);
  await p
    .getByRole("textbox", { name: "Почта", exact: true })
    .fill(values.email);
  await p.getByLabel("Пароль", { exact: true }).fill(values.password);
  await p.getByLabel("Повтори пароль", { exact: true }).fill(values.password);
  await p.getByRole("checkbox").check();
  await p.getByRole("button", { name: "Создать кабинет", exact: true }).click();
  await p.locator(".account-heading").waitFor();
}
async function sing(p) {
  await p.getByRole("button", { name: "Спеть", exact: true }).first().click();
  await p
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await p.getByRole("button", { name: "Начать пение", exact: true }).click();
  await p.locator(".result-screen").waitFor({ timeout: 35000 });
}
try {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    permissions: ["microphone", "clipboard-read", "clipboard-write"],
  });
  await fixture(ctx);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  let failSave = true;
  await p.route("**/api/attempts", async (route) => {
    if (route.request().method() === "POST" && failSave) {
      failSave = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Проверка временного сбоя" }),
      });
    }
    return route.continue();
  });
  await p.goto(baseURL);
  await p.locator(".song-card").first().waitFor();
  await sizes(p, "catalog");
  assert.equal(await p.locator("nav button").count(), 2);
  await p.getByRole("button", { name: "Кабинет", exact: true }).click();
  await sizes(p, "login");
  await p.getByRole("button", { name: "Регистрация", exact: true }).click();
  await sizes(p, "register");
  await snap(p, "register-small", 390, 844);
  await p.setViewportSize({ width: 1366, height: 768 });
  await p.getByRole("textbox", { name: "Имя", exact: true }).fill(account.name);
  await p
    .getByRole("textbox", { name: "Почта", exact: true })
    .fill(account.email);
  await p.getByLabel("Пароль", { exact: true }).fill(account.password);
  await p
    .getByLabel("Повтори пароль", { exact: true })
    .fill("Not-the-same-password");
  await p.getByRole("checkbox").check();
  await p.getByRole("button", { name: "Создать кабинет", exact: true }).click();
  await p
    .getByRole("alert")
    .filter({ hasText: "Пароли не совпадают" })
    .waitFor();
  await p.getByLabel("Повтори пароль", { exact: true }).fill(account.password);
  await p.getByRole("button", { name: "Создать кабинет", exact: true }).click();
  await p.locator(".account-heading").waitFor();
  await sizes(p, "empty-account");
  await p.reload();
  await p.getByRole("button", { name: "Кабинет", exact: true }).click();
  await p.getByRole("heading", { name: account.name, exact: true }).waitFor();
  await p
    .getByRole("button", { name: "Спеть новую попытку", exact: true })
    .click();
  await p.getByRole("button", { name: "Спеть", exact: true }).first().click();
  await p.locator(".focus-screen").waitFor();
  assert.equal(await p.locator(".detail-page").count(), 0);
  await sizes(p, "setup");
  await p
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await p.getByRole("button", { name: "Начать пение", exact: true }).click();
  await p.waitForTimeout(5200);
  await snap(p, "singing");
  await p.locator(".result-screen").waitFor({ timeout: 30000 });
  await p.waitForTimeout(1000);
  await p
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .waitFor();
  await p
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(await p.locator(".notice").count(), 0);
  await sizes(p, "result");
  await p
    .getByRole("button", { name: "Скопировать ссылку-вызов", exact: true })
    .click();
  await p.getByText("Ссылка скопирована", { exact: true }).waitFor();
  const challenge = await p
    .getByRole("textbox", { name: "Ссылка-вызов", exact: true })
    .inputValue();
  await p.getByRole("button", { name: "Петь", exact: true }).click();
  await p
    .getByRole("button", {
      name: "← Вернуться к последнему разбору",
      exact: true,
    })
    .click();
  await p.locator(".result-screen").waitFor();
  await p.getByRole("button", { name: "Кабинет", exact: true }).click();
  await p.getByText("Дубль 1", { exact: true }).first().waitFor();
  await sizes(p, "history");
  await p.getByRole("button", { name: "Разобрать", exact: true }).click();
  await snap(p, "saved-breakdown");
  await p.getByRole("button", { name: "Настройки", exact: true }).click();
  await sizes(p, "settings");
  await p.getByRole("textbox", { name: "Имя", exact: true }).fill("Аня Вокал");
  await p.getByRole("button", { name: "Сохранить имя" }).click();
  await p.getByText("Имя обновлено.", { exact: true }).waitFor();
  await p.getByLabel("Текущий пароль", { exact: true }).fill(account.password);
  await p
    .getByLabel("Новый пароль", { exact: true })
    .fill("Changed-password-2026");
  await p.getByRole("button", { name: "Изменить пароль", exact: true }).click();
  await p
    .getByText("Пароль изменён. Другие сеансы завершены.", { exact: true })
    .waitFor();
  account.password = "Changed-password-2026";
  await p.getByRole("button", { name: "Выйти", exact: true }).click();
  await p.getByRole("button", { name: "Петь", exact: true }).click();
  assert.equal(
    await p
      .getByRole("button", {
        name: "← Вернуться к последнему разбору",
        exact: true,
      })
      .count(),
    0,
  );
  await p.getByRole("button", { name: "Кабинет", exact: true }).click();
  await p.getByRole("textbox", { name: "Почта", exact: true }).waitFor();
  const ctx2 = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    permissions: ["microphone"],
  });
  await fixture(ctx2);
  const q = await ctx2.newPage();
  q.on("pageerror", (e) => errors.push(e.message));
  await q.goto(baseURL);
  await q.getByRole("button", { name: "Кабинет", exact: true }).click();
  await q
    .getByRole("textbox", { name: "Почта", exact: true })
    .fill(account.email);
  await q.getByLabel("Пароль", { exact: true }).fill("Incorrect-password-2026");
  await q.getByRole("button", { name: "Войти", exact: true }).last().click();
  await q
    .getByRole("alert")
    .filter({ hasText: "Неверная почта или пароль" })
    .waitFor();
  await snap(q, "login-error");
  await q.getByLabel("Пароль", { exact: true }).fill(account.password);
  await q.getByRole("button", { name: "Войти", exact: true }).last().click();
  await q.getByText("Дубль 1", { exact: true }).first().waitFor();
  await q.getByRole("heading", { name: "Аня Вокал", exact: true }).waitFor();
  await q.getByRole("button", { name: "Выйти", exact: true }).click();
  await register(q, {
    ...account,
    email: account.email.replace("qa-", "qa-other-"),
    name: "Другой участник",
  });
  await q
    .getByRole("heading", { name: "Пока нет результатов", exact: true })
    .waitFor();
  await q.goto(challenge);
  await q.getByRole("button", { name: "Принять вызов", exact: true }).click();
  await q
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await q.getByRole("button", { name: "Начать пение", exact: true }).click();
  await q
    .getByText("Дуэль завершена", { exact: true })
    .waitFor({ timeout: 35000 });
  await sizes(q, "duel");
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/checks.json`,
    JSON.stringify(
      {
        checks,
        errors,
        accounts: [account.email, account.email.replace("qa-", "qa-other-")],
        crossBrowserLogin: true,
        retryFailedSave: true,
        clearsRecordingOnLogout: true,
        privateHistory: true,
        changePassword: true,
        directSingingFlow: true,
        duel: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${checks.length} layouts; server account, private history, password change, cross-browser login, singing and duel`,
  );
} finally {
  await browser.close();
}
