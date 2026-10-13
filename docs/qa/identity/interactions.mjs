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
                        ? 2
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
    deviceScaleFactor: 2,
    permissions: ["microphone"],
  });
  await fixture(context);
  const page = await context.newPage();
  observe(page);
  await page.goto(baseURL);
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Включить микрофон", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать пение", exact: true })
    .waitFor();
  await page.waitForTimeout(1200);
  await snap(page, "microphone-hidpi");
  await page.getByRole("button", { name: "Начать пение", exact: true }).click();
  await page.waitForTimeout(5200);
  const performanceData = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now(),
          gaps = [];
        let last = start;
        const frame = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - start < 2000) requestAnimationFrame(frame);
          else
            resolve({
              frames: gaps.length,
              meanMs: gaps.reduce((a, b) => a + b) / gaps.length,
              maxMs: Math.max(...gaps),
            });
        };
        requestAnimationFrame(frame);
      }),
  );
  const canvasSize = await page
    .locator(".piano")
    .evaluate((c) => ({
      actual: c.width,
      expected: Math.round(c.clientWidth * devicePixelRatio),
    }));
  assert.equal(canvasSize.actual, canvasSize.expected);
  await page
    .getByText("Твой результат", { exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  const data = () =>
    page.locator(".timeline-panel canvas").evaluate((c) => c.toDataURL());
  const a = await data();
  await page.getByRole("button", { name: "Идеальный я", exact: true }).click();
  await page.waitForTimeout(200);
  const mid = await data();
  await page.waitForTimeout(600);
  const b = await data();
  assert.notEqual(a, b, "A/B did not morph");
  assert.notEqual(mid, b, "A/B has no intermediate visual frame");
  await snap(page, "ideal-b");
  await page.getByRole("button", { name: "Как пел", exact: true }).click();
  await page.waitForTimeout(650);
  assert.equal(await data(), a, "A/B return changed recorded contour");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Идеальный я", exact: true }).click();
  await page.waitForTimeout(80);
  const still = await data();
  await page.waitForTimeout(250);
  assert.equal(
    await data(),
    still,
    "reduced-motion did not settle immediately",
  );
  await snap(page, "reduced-motion");
  await page.getByRole("button", { name: "Как пел", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Идеальный я");
  const outline = await page
    .locator(":focus")
    .evaluate((e) => getComputedStyle(e).outlineWidth);
  assert.notEqual(outline, "0px");
  await snap(page, "narrow", 800, 768);
  await snap(page, "small", 390, 844);
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/interaction-checks.json`,
    JSON.stringify(
      {
        browser: await browser.version(),
        performanceData,
        canvasSize,
        abMorph: true,
        reversible: true,
        reducedMotion: true,
        focus: true,
        errors,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS",
    JSON.stringify({
      performanceData,
      canvasSize,
      abMorph: true,
      reducedMotion: true,
      focus: true,
    }),
  );
} finally {
  await browser.close();
}
