import { chromium } from "@playwright/test";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1366, height: 768 } });
await p.goto(process.argv[2]);
await p.waitForTimeout(800);
console.log(await p.evaluate(() => ({
  header: document.querySelector("header.top")?.getBoundingClientRect().height,
  main: document.querySelector("main")?.getBoundingClientRect().height,
  footer: document.querySelector("footer.foot")?.getBoundingClientRect().height,
  page: document.querySelector(".page, .cabinet")?.getBoundingClientRect().height,
  total: document.documentElement.scrollHeight,
})));
await b.close();
