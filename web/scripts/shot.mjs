// Скриншоты экранов: node scripts/shot.mjs <url> <out.png> [width] [height]
import { chromium } from "@playwright/test";
const [url, out, w = "1366", h = "768"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
await page.screenshot({ path: out });
await browser.close();
