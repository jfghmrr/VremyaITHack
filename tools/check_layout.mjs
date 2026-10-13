import { chromium } from "playwright";
import assert from "node:assert/strict";
const baseURL = process.env.ECHO_BASE_URL || "http://127.0.0.1:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  for (const [width, height] of [
    [1366, 768],
    [1920, 1080],
    [800, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(baseURL);
    await page
      .getByRole("button", { name: "Спеть ↗", exact: true })
      .first()
      .waitFor();
    const dimensions = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    assert.ok(dimensions.w <= width);
    if (width >= 1366) assert.ok(dimensions.h <= height);
  }
  console.log("PASS: desktop home layout at 1366, 1920 and 800 px.");
} finally {
  await browser.close();
}
