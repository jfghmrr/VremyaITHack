// Основной шрифт — Golos Text в WOFF2 (латиница и кириллица): страница грузит только его, и
// каждый знак интерфейса, каталога и ответов сервера рисуется им, а не запасным шрифтом.
import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Знаков нет и в полном Golos Text: браузер всегда брал их из системного шрифта.
const NOT_IN_GOLOS = new Set([..."■▶◌●♡♪★✓🎤"]);

function files(dir: string, re: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "wasm" ? [] : files(p, re);
    return re.test(f) ? [p] : [];
  });
}

/** Все не-ASCII знаки, которые сайт может показать: интерфейс, каталог песен, ответы API. */
function usedCharacters(): string[] {
  const sources = [...files("src", /\.(svelte|ts|css|html|json)$/), ...files("static/songs", /\.json$/), ...files("../crates/api/src", /\.rs$/)];
  const chars = new Set<string>();
  for (const f of sources) for (const c of readFileSync(f, "utf8")) if (c.codePointAt(0)! > 0x7e && !/\s/.test(c) && !NOT_IN_GOLOS.has(c)) chars.add(c);
  return [...chars].sort();
}

test("Golos Text: WOFF2 вместо TTF, все знаки сайта рисуются им", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "шрифты отрисовки видны только через CDP");
  const fonts: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/fonts/")) fonts.push(new URL(r.url()).pathname); });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(fonts.filter((f) => f.includes("GolosText"))).toEqual(["/fonts/GolosText.woff2"]);

  const chars = usedCharacters();
  expect(chars.length).toBeGreaterThan(70);
  for (const c of ["ё", "—", "«", "»", "…", "→"]) expect(chars).toContain(c);
  const text = chars.join("") + "Ё№₽";
  for (const weight of [400, 700]) {
    await page.evaluate(({ text, weight }) => {
      const el = document.createElement("p");
      el.id = "glyphs";
      el.textContent = text;
      el.style.cssText = `font-family: "Golos Text"; font-weight: ${weight}`;
      document.getElementById("glyphs")?.remove();
      document.body.append(el);
    }, { text, weight });
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#glyphs" });
    const { fonts: used } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(used.map((f) => ({ family: f.familyName, custom: f.isCustomFont })), `вес ${weight}`).toEqual([{ family: "Golos Text", custom: true }]);
    await cdp.detach();
  }
});
