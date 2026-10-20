// Попиксельное сравнение прогонов tests/e2e/desktop-pixels.spec.ts (до и после правок).
// Нужен ImageMagick 7 (`magick`). Печатает таблицу «экран × размер × движок → разных пикселей»
// в Markdown: пиксель считается разным, если отличается хоть один канал хоть на один уровень
// (`compare -metric AE` в ImageMagick 7.1.2 печатает взвешенное число, поэтому считаем сами).
//   node tests/desktop-pixels-compare.mjs <до>[,<до-2>...] <после>[,<после-2>...]
// Несколько прогонов через запятую: одна и та же сборка дважды даёт разные пиксели на нескольких
// экранах (шум растра браузера, особенно WebKit; см. отчёт). Экран считается неизменным, если
// хоть один прогон «после» попиксельно совпал хоть с одним прогоном «до»; иначе печатается
// наименьшая разница, а карта отличий (белое — разные пиксели) пишется в <первая папка после>-diff/.
// Код выхода 1, если хоть один снимок отличается, отсутствует или другого размера.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [beforeArg, afterArg] = process.argv.slice(2);
if (!beforeArg || !afterArg) {
  console.error("usage: node tests/desktop-pixels-compare.mjs <before>[,<before2>] <after>[,<after2>]");
  process.exit(2);
}
const befores = beforeArg.split(",");
const afters = afterArg.split(",");
const diffDir = `${afters[0].replace(/\/$/, "")}-diff`;
const size = (/** @type {string} */ file) => execFileSync("magick", ["identify", "-format", "%wx%h", file], { encoding: "utf8" }).trim();
// Разница по каналам → максимум по каналам → порог 0: белое там, где пиксели не равны.
const map = ["-compose", "difference", "-composite", "-channel", "RGB", "-separate", "-evaluate-sequence", "max", "-threshold", "0"];

/** @returns {{ count: number, text: string }} число разных пикселей (Infinity — сравнить нельзя) и описание */
function compare(/** @type {string} */ a, /** @type {string} */ b) {
  if (!existsSync(a) || !existsSync(b)) return { count: Infinity, text: !existsSync(a) ? "нет в «до»" : "нет в «после»" };
  if (size(a) !== size(b)) return { count: Infinity, text: `размер ${size(a)} → ${size(b)}` };
  const out = spawnSync("magick", [a, b, ...map, "-format", "%[fx:round(mean*w*h)] %@", "info:"], { encoding: "utf8" });
  const [count, box] = (out.stdout || "").trim().split(" ");
  if (!/^\d+$/.test(count ?? "")) return { count: Infinity, text: `ошибка: ${out.stderr.trim()}` };
  return { count: Number(count), text: count === "0" ? "0" : `${count} (область ${box})` };
}

const names = new Set([...befores, ...afters].flatMap((d) => readdirSync(d)).filter((f) => f.endsWith(".png")));
const rows = [];
let bad = 0;
for (const name of [...names].sort()) {
  const m = /^(chromium|webkit)-(.+)-(\d+x\d+)\.png$/.exec(name);
  const [engine, screen, dims] = m ? [m[1], m[2], m[3]] : ["?", name, "?"];
  let best = { count: Infinity, text: "нет снимков", a: "", b: "" };
  for (const before of befores)
    for (const after of afters) {
      if (best.count === 0) break;
      const r = compare(join(before, name), join(after, name));
      if (r.count < best.count || best.text === "нет снимков") best = { ...r, a: join(before, name), b: join(after, name) };
    }
  if (best.count !== 0) {
    bad++;
    if (Number.isFinite(best.count)) {
      mkdirSync(diffDir, { recursive: true });
      spawnSync("magick", [best.a, best.b, ...map, join(diffDir, basename(name))]);
    }
  }
  rows.push(`| ${screen} | ${dims} | ${engine} | ${best.text} |`);
}
console.log("| Экран | Размер | Движок | Разных пикселей |\n| --- | --- | --- | --- |\n" + rows.join("\n"));
console.log(`\n${rows.length} снимков, с разницей или без пары: ${bad}`);
process.exit(bad ? 1 : 0);
