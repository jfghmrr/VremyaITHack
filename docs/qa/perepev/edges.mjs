import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const base = process.env.ECHO_BASE_URL || "http://127.0.0.1:5173/";
const output = process.env.ECHO_QA_OUTPUT || "docs/qa/perepev";
try {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator(".song-card").first().waitFor();
  const rects = await page.locator(".song-card").evaluateAll((xs) =>
    xs.map((x) => {
      const r = x.getBoundingClientRect();
      return { y: r.y, width: r.width, height: r.height };
    }),
  );
  assert.equal(rects.length, 2);
  assert.ok(Math.abs(rects[0].y - rects[1].y) < 1);
  assert.ok(Math.abs(rects[0].width - rects[1].width) < 1);
  assert.ok(Math.abs(rects[0].height - rects[1].height) < 1);
  await page.keyboard.press("Tab");
  assert.ok(
    await page.evaluate(() => document.activeElement.matches(":focus-visible")),
  );
  await page.getByRole("button", { name: "Регистрация", exact: true }).click();
  await page.getByRole("textbox", { name: "Твоё имя" }).fill("Саша");
  await page.getByRole("checkbox").check();
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  await page.getByRole("button", { name: "Создать профиль" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Не удалось сохранить профиль" })
    .waitFor();
  await page.screenshot({
    path: `${output}/storage-error-1366.png`,
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight),
    768,
  );
  await page
    .getByRole("button", { name: "Продолжить без регистрации" })
    .click();
  await page.locator(".song-card").first().waitFor();
  await ctx.close();
  const quiet = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  await quiet.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = new AudioContext();
      await c.resume();
      const d = c.createMediaStreamDestination();
      const s = c.createOscillator(),
        g = c.createGain();
      g.gain.value = 0;
      s.connect(g).connect(d);
      s.start();
      window.__quietContext = c;
      return d.stream;
    };
  });
  const p = await quiet.newPage();
  await p.goto(base);
  await p.getByRole("button", { name: "Спеть", exact: true }).first().click();
  await p.getByRole("button", { name: "Проверить микрофон" }).click();
  await p
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await p.getByText(/Ничего не слышно/).waitFor();
  await p.screenshot({
    path: `${output}/quiet-microphone-1366.png`,
    fullPage: true,
  });
  assert.equal(await p.getByRole("meter").getAttribute("aria-valuenow"), "0");
  await quiet.close();
  await writeFile(
    `${output}/edges.json`,
    JSON.stringify(
      {
        cardAlignment: true,
        keyboardFocus: true,
        reducedMotionAndDPR2: true,
        blockedStorage: true,
        quietMicrophone: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS alignment, focus, DPR2/reduced-motion, blocked storage, quiet microphone",
  );
} finally {
  await browser.close();
}
