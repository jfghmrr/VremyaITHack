// Сцена пения для каждой песни каталога: на листе видны слова, а график рисует линию
// эталона там, где в reference.json есть голос. Владелец увидел на iPhone вместо линии
// несколько точек: короткие отрезки живого вокала схлопывались в отрезки нулевой длины,
// а их Canvas не рисует ни в Chromium, ни в WebKit.
// Покрытие считается по пикселям цвета эталона в столбцах окна графика и сравнивается
// с озвученными кадрами reference.json в том же окне (время берётся из AudioContext сцены
// на паузе). Снимки: test-results/stage/<движок>-<ширина>x<высота>-<песня>.png,
// измерения: test-results/stage/<движок>.jsonl (STAGE_OUT меняет папку: Playwright очищает
// test-results в начале каждого прогона).
// STAGE_DESKTOP=1 добавляет прогон в окне ноутбука 1366×768. STAGE_SONGS=id,id — только эти песни.
// Кроме покрытия проверяется высота: линия в каждом нарисованном столбце не дальше полутора
// полутонов от эталона, так что сдвинутая или неверно соединённая линия не пройдёт.
import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";
import { MAX_SPAN, MIN_SPAN, PX_PER_S } from "../../src/lib/ui/reference-line";

type Reference = { id: string; hop_ms: number; duration_s: number; f0_midi: (number | null)[]; lyrics: { t: number; text: string }[] };
type Size = { w: number; h: number };

const songs = new URL("../../static/songs/", import.meta.url);
const only = process.env.STAGE_SONGS?.split(",").filter(Boolean);
const catalog = (JSON.parse(readFileSync(new URL("index.json", songs), "utf8")) as { id: string }[]).map((s) => s.id).filter((id) => !only || only.includes(id));
const reference = (id: string): Reference => JSON.parse(readFileSync(new URL(`${id}/reference.json`, songs), "utf8"));
const out = process.env.STAGE_OUT ?? "test-results/stage";
const normalize = (text: string) => text.replaceAll(" · ", " ").replace(/\s+/g, " ").trim();

/** Минимальная доля озвученного эталона в окне, которую должен нарисовать график. */
const MIN_COVERAGE = 0.8;
/** Наибольшая доля нарисованных столбцов, где линия дальше полутора полутонов от высоты эталона. */
const MAX_OFF_PITCH = 0.1;
/** Секунда песни, на которой сцена ставится на паузу и измеряется (как на снимке владельца). */
const AT = 3;

/** Время сцены: AudioContext и момент старта минусовки (тот же отсчёт, что у графика). */
async function trackStart(page: Page) {
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when = 0, ...rest: number[]) {
      if (this.buffer && this.buffer.duration > 5) (window as unknown as { __stage: unknown }).__stage = { ctx: this.context, when };
      return start.call(this, when, ...(rest as [number, number]));
    } as typeof AudioBufferSourceNode.prototype.start;
  });
}

type Measure = { now: number; width: number; span: number; dpr: number; predicted: number; covered: number; spurious: number; offPitch: number };

/** Столбцы графика с пикселями цвета эталона против озвученных кадров reference.json. */
function measure(page: Page, song: Reference): Promise<Measure> {
  return page.evaluate(({ f0, hop, pxPerS, minSpan, maxSpan }) => {
    const clock = (window as unknown as { __stage: { ctx: BaseAudioContext; when: number } }).__stage;
    const now = Math.max(0, clock.ctx.currentTime - clock.when);
    const canvas = document.querySelector<HTMLCanvasElement>(".stage .screen canvas")!;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = canvas.width / w;
    const g = canvas.getContext("2d")!;
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const ref = getComputedStyle(canvas).getPropertyValue("--stage-reference").trim();
    const [r, gg, b] = [1, 3, 5].map((i) => parseInt(ref.slice(i, i + 2), 16));
    // Те же константы окна, что у PianoRoll (stageSpan): около 55 px на секунду, от 6 до 9 секунд,
    // «сейчас» на четверти ширины. И та же шкала высоты: от минимума эталона −4 до максимума +4.
    const span = Math.min(maxSpan, Math.max(minSpan, w / pxPerS));
    const left = now - span * 0.25;
    const rows = Math.floor((h - 21) * dpr); // без подписей секунд внизу
    let lo = Infinity, hi = -Infinity;
    for (const m of f0) if (m !== null) (lo = Math.min(lo, m)), (hi = Math.max(hi, m));
    lo -= 4;
    hi += 4;
    const yOf = (m: number) => h - 32 - ((m - lo) / (hi - lo)) * (h - 64);
    const tolerance = (1.5 * (h - 64)) / (hi - lo) + 3;
    let predicted = 0, covered = 0, spurious = 0, offPitch = 0;
    for (let c = 0; c < w; c++) {
      if (Math.abs(c + 0.5 - w / 4) <= 3) continue; // линия «сейчас» и точка своего голоса
      const t = left + ((c + 0.5) / w) * span;
      const i = Math.floor(t / hop);
      const voiced = i >= 0 && i < f0.length && f0[i] !== null;
      let hits = 0;
      const ys: number[] = [];
      for (let x = Math.floor(c * dpr); x < Math.floor((c + 1) * dpr); x++)
        for (let y = 0; y < rows; y++) {
          const k = (y * canvas.width + x) * 4;
          if (data[k + 3] > 200 && Math.abs(data[k] - r) <= 20 && Math.abs(data[k + 1] - gg) <= 20 && Math.abs(data[k + 2] - b) <= 20) {
            hits++;
            ys.push(y / dpr);
          }
        }
      const drawn = hits >= 2 * dpr;
      if (voiced) {
        predicted++;
        if (drawn) {
          covered++;
          // Линия на нужной высоте: середина закрашенных пикселей столбца у высоты эталона в этом кадре.
          ys.sort((a, b) => a - b);
          if (Math.abs(ys[ys.length >> 1] - yOf(f0[i]!)) > tolerance) offPitch++;
        }
      } else if (drawn) spurious++;
    }
    return { now, width: w, span, dpr, predicted, covered, spurious, offPitch };
  }, { f0: song.f0_midi, hop: song.hop_ms / 1000, pxPerS: PX_PER_S, minSpan: MIN_SPAN, maxSpan: MAX_SPAN });
}

/** Слова на листе: все строки песни, текущая строка видна целиком внутри листа и окна. */
async function checkLyrics(page: Page, song: Reference, now: number, where: string) {
  const sheet = page.locator(".stage ol.lines");
  await expect(sheet, `${where}: лист со словами`).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box?.height ?? 0, `${where}: высота листа со словами`).toBeGreaterThan(30);
  const lines = (await sheet.locator("li").allInnerTexts()).map(normalize).filter((t) => t !== "Вдохни. Выбери удобную высоту.");
  expect(lines, `${where}: строки песни на листе`).toEqual(song.lyrics.map((l) => normalize(l.text)));
  const current = song.lyrics.findLastIndex((l) => l.t <= now);
  const expected = current < 0 ? "Вдохни. Выбери удобную высоту." : normalize(song.lyrics[current].text);
  const now_ = sheet.locator("li.now");
  await expect(now_, `${where}: текущая строка`).toHaveCount(1);
  expect(normalize(await now_.innerText()), `${where}: текст текущей строки`).toBe(expected);
  // Доля, а не 1: тетрадь на ноутбуке повёрнута на 0,6°, рамка строки задевает край окна на доли пикселя.
  await expect(now_, `${where}: текущая строка в окне`).toBeInViewport({ ratio: 0.95 });
  const inside = await now_.evaluate((li) => {
    const a = li.getBoundingClientRect();
    const s = li.closest("ol")!.getBoundingClientRect();
    return a.top >= s.top - 1 && a.bottom <= s.bottom + 1;
  });
  expect(inside, `${where}: текущая строка не прокручена за край листа`).toBe(true);
}

function suite(group: string, sizes: Size[], mobile: boolean) {
  test.describe(`сцена пения: ${group}`, () => {
    test.skip(group === "ноутбук" && !process.env.STAGE_DESKTOP, "окно ноутбука — по STAGE_DESKTOP=1");
    test.use({ isMobile: mobile, hasTouch: mobile, viewport: { width: sizes[0].w, height: sizes[0].h } });

    for (const id of catalog) {
      test(`${id}: слова и линия эталона`, async ({ page, context, browserName }) => {
        test.setTimeout(60_000);
        const song = reference(id);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await fakeMic(context, id);
        await trackStart(page);
        await page.goto(`/sing/${id}`);
        await page.getByRole("button", { name: "Включить микрофон" }).click();
        const go = page.getByRole("button", { name: "Начать пение" });
        await expect(go).toBeEnabled({ timeout: 20_000 });
        await go.click();
        await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
        await page.waitForFunction((at) => {
          const s = (window as unknown as { __stage?: { ctx: BaseAudioContext; when: number } }).__stage;
          return !!s && s.ctx.currentTime - s.when >= at;
        }, AT, { timeout: 20_000 });
        await page.getByRole("button", { name: "Пауза", exact: true }).click();
        await expect(page.getByRole("button", { name: "Продолжить", exact: true })).toBeVisible();
        mkdirSync(out, { recursive: true });
        for (const s of sizes) {
          await page.setViewportSize({ width: s.w, height: s.h });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(400); // ResizeObserver и несколько кадров перерисовки
          const where = `${browserName} ${s.w}×${s.h} ${id}`;
          const m = await measure(page, song);
          // Плашка паузы закрывает график только на снимке: пиксели канваса читаются под ней.
          await page.screenshot({ path: `${out}/${browserName}-${s.w}x${s.h}-${id}.png`, style: ".stage .overlay { display: none !important; }" });
          const coverage = m.predicted ? m.covered / m.predicted : 1;
          appendFileSync(`${out}/${browserName}.jsonl`, JSON.stringify({ id, size: `${s.w}x${s.h}`, ...m, coverage: +coverage.toFixed(3) }) + "\n");
          await checkLyrics(page, song, m.now, where);
          expect.soft(m.predicted, `${where}: в окне есть голос эталона`).toBeGreaterThan(0);
          expect.soft(coverage, `${where}: доля нарисованного эталона (${m.covered}/${m.predicted} столбцов, сейчас ${m.now.toFixed(2)} с)`).toBeGreaterThanOrEqual(MIN_COVERAGE);
          expect.soft(m.covered ? m.offPitch / m.covered : 0, `${where}: столбцы с линией не на своей высоте (${m.offPitch}/${m.covered})`).toBeLessThanOrEqual(MAX_OFF_PITCH);
        }
      });
    }
  });
}

suite("телефон", [{ w: 390, h: 844 }, { w: 844, h: 390 }], true);
suite("ноутбук", [{ w: 1366, h: 768 }], false);
