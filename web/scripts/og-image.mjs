// Картинка для превью ссылки (og:image, 1200×630): собирается из готовой графики сайта —
// фон комнаты, логотип, кот в кресле и бумажная полоска со слоганом. Новых рисунков нет,
// текст набран шрифтами сайта. Запуск из web/: node scripts/og-image.mjs
// Результат: static/og-image.jpg (JPEG, качество 86).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../static/", import.meta.url));
const types = { webp: "image/webp", woff2: "font/woff2" };
// Файлы встраиваются как data:-URL: страница собирается без сервера и сети.
const url = (path) => `data:${types[path.split(".").pop()]};base64,${readFileSync(root + path).toString("base64")}`;

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
@font-face { font-family: Caveat; src: url("${url("fonts/Caveat.woff2")}") format("woff2"); font-weight: 400 700; }
@font-face { font-family: Golos; src: url("${url("fonts/GolosText.woff2")}") format("woff2"); font-weight: 400 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; background: #171719; }
.wall { position: absolute; inset: 0; background: url("${url("art/backgrounds/home-no-lamp.webp")}") center / cover; filter: saturate(.68) brightness(.5); }
.shade { position: absolute; inset: 0; background: radial-gradient(ellipse 60% 70% at 66% 45%, #17171900, #171719cc 90%), linear-gradient(90deg, #17171955, transparent 35%, transparent 62%, #171719e0); }
.chair { position: absolute; left: 34px; bottom: 26px; width: 400px; }
.cat { position: absolute; left: 112px; bottom: 196px; width: 248px; filter: drop-shadow(0 10px 8px #0008); }
.logo { position: absolute; right: 52px; top: 70px; width: 680px; filter: drop-shadow(0 8px 6px #0009); }
.strip { position: absolute; right: 120px; top: 268px; width: 560px; padding: 22px 26px 28px; background: #efe6d2; color: #1f1c1a; font: 700 54px/1 Caveat; text-align: center; rotate: -3deg;
  clip-path: polygon(0 7%,4% 4%,24% 5%,50% 0,70% 3%,96% 0,100% 5%,98% 32%,100% 68%,98% 97%,81% 95%,60% 100%,31% 96%,3% 100%,0 91%,2% 68%,0 45%); }
.strip span { display: block; }
.note { position: absolute; right: 160px; top: 468px; width: 480px; color: #efe6d2; font: 500 26px/1.3 Golos; text-align: center; text-shadow: 0 2px 6px #000; }
.url { position: absolute; right: 52px; bottom: 30px; color: #b8b0a0; font: 600 22px Golos; letter-spacing: .02em; }
</style></head><body>
<div class="wall"></div><div class="shade"></div>
<img class="chair" src="${url("art/furniture/armchair.webp")}" alt="">
<img class="cat" src="${url("art/mascots/cat-listen-s01.webp")}" alt="">
<img class="logo" src="${url("art/branding/logo-main-s01.webp")}" alt="">
<p class="strip"><span>Караоке, где твой голос</span><span>имеет значение ♡</span></p>
<p class="note">Спой в своей тональности и вызови друга на дуэль</p>
<p class="url">perepev.lumnex.ru</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: root + "og-image.jpg", type: "jpeg", quality: 86 });
await browser.close();
console.log("static/og-image.jpg");
