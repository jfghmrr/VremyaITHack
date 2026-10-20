// Своя линия на сцене пения не прыгает. Владелец (2026-10-18): «когда я пою, почему-то сдвигается
// то вверх, то вниз график тональности». Раньше вся видимая линия рисовалась со сдвигом тональности
// по медиане последних 3 с и прыгала целиком, когда эта медиана менялась.
// Синтетический певец поёт эталон, а с KEY_AT секунды — на KEY полутонов выше (новая тональность).
// Сцена несколько раз встаёт на паузу; на паузе для каждого столбца графика известна секунда песни
// (время из AudioContext сцены), и высота своей линии в одной и той же секунде сравнивается между
// снимками: уже нарисованная точка не должна сдвинуться. В конце новая тональность принята:
// свежие точки снова на линии эталона.
// Снимки: test-results/stage-line/<секунда>.png, измерения — test-results/stage-line/samples.json
// (STAGE_LINE_OUT меняет папку).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";
import { MAX_SPAN, MIN_SPAN, PX_PER_S } from "../../src/lib/ui/reference-line";

const SONG = "danny-boy-evans";
const reference = JSON.parse(readFileSync(new URL(`../../static/songs/${SONG}/reference.json`, import.meta.url), "utf8")) as { hop_ms: number; duration_s: number; f0_midi: (number | null)[] };
const out = process.env.STAGE_LINE_OUT ?? "test-results/stage-line";
/** Секунда песни, с которой певец поёт выше. */
const KEY_AT = 8;
/** На сколько полутонов выше. */
const KEY = 5;
/** Паузы: секунды песни. */
const PAUSES = Array.from({ length: 17 }, (_, k) => KEY_AT + 0.75 + k * 0.75);

type Sample = { now: number; w: number; span: number; left: number; semitone: number; ys: (number | null)[]; ref: (number | null)[] };

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

/** Высота своей линии (середина малиновых пикселей) в каждом столбце графика и высота эталона там же. */
function sample(page: Page): Promise<Sample> {
  return page.evaluate(({ f0, hop, pxPerS, minSpan, maxSpan }) => {
    const clock = (window as unknown as { __stage: { ctx: BaseAudioContext; when: number } }).__stage;
    const now = Math.max(0, clock.ctx.currentTime - clock.when);
    const canvas = document.querySelector<HTMLCanvasElement>(".stage .screen canvas")!;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = canvas.width / w;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    // Окно и шкала высоты — как у PianoRoll (stageSpan, эталон −4…+4 полутона).
    const span = Math.min(maxSpan, Math.max(minSpan, w / pxPerS));
    const left = now - span * 0.25;
    let lo = Infinity, hi = -Infinity;
    for (const m of f0) if (m !== null) (lo = Math.min(lo, m)), (hi = Math.max(hi, m));
    lo -= 4;
    hi += 4;
    const yOf = (m: number) => h - 32 - ((m - lo) / (hi - lo)) * (h - 64);
    const rows = Math.floor((h - 21) * dpr);
    const ys: (number | null)[] = [];
    const ref: (number | null)[] = [];
    for (let c = 0; c < w; c++) {
      const t = left + ((c + 0.5) / w) * span;
      const r = f0[Math.round(t / hop)];
      ref.push(r == null ? null : yOf(r));
      ys.push(null);
      if (Math.abs(c + 0.5 - w / 4) <= 8) continue; // линия «сейчас» и точка своего голоса
      const hits: number[] = [];
      for (let x = Math.floor(c * dpr); x < Math.floor((c + 1) * dpr); x++)
        for (let y = 0; y < rows; y++) {
          const k = (y * canvas.width + x) * 4;
          // Малиновый своей линии (#e2525a), в том числе полупрозрачный поверх серого эталона;
          // серый эталон, сетка, подписи и голубой соперник сюда не попадают.
          if (data[k + 3] > 100 && data[k] - Math.max(data[k + 1], data[k + 2]) >= 60) hits.push(y / dpr);
        }
      if (hits.length >= 2 * dpr) ys[c] = hits[hits.length >> 1];
    }
    return { now, w, span, left, semitone: (h - 64) / (hi - lo), ys, ref };
  }, { f0: reference.f0_midi, hop: reference.hop_ms / 1000, pxPerS: PX_PER_S, minSpan: MIN_SPAN, maxSpan: MAX_SPAN });
}

test("своя линия: нарисованные точки не прыгают, когда певец меняет тональность", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const at = Math.round(KEY_AT / 0.01);
  await fakeMic(context, SONG, { errors: [[at, reference.f0_midi.length, KEY]] });
  await trackStart(page);
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  const go = page.getByRole("button", { name: "Начать пение" });
  await expect(go).toBeEnabled({ timeout: 20_000 });
  await go.click();
  await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
  mkdirSync(out, { recursive: true });

  const samples: Sample[] = [];
  for (const pause of PAUSES) {
    await page.waitForFunction((at) => {
      const s = (window as unknown as { __stage?: { ctx: BaseAudioContext; when: number } }).__stage;
      return !!s && s.ctx.currentTime - s.when >= at;
    }, pause, { timeout: 30_000 });
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    await expect(page.getByRole("button", { name: "Продолжить", exact: true })).toBeVisible();
    await page.waitForTimeout(250); // несколько кадров перерисовки на остановленных часах
    const s = await sample(page);
    samples.push(s);
    await page.screenshot({ path: `${out}/${s.now.toFixed(2)}.png`, style: ".stage .overlay { display: none !important; }" });
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
  }
  writeFileSync(`${out}/samples.json`, JSON.stringify(samples));

  // Одна и та же секунда песни на двух снимках: столбец позднего снимка против ближайшего столбца
  // раннего. Самые свежие 250 мс раннего снимка не сравниваются: последняя точка ещё сглаживается
  // по следующему кадру детектора, кадры приходят с задержкой 30 мс, а рядом с «сейчас» — точка
  // голоса (радиус 6 px). Сравниваются ровные места линии: на переходе между нотами линия почти
  // вертикальна, и середина столбца зависит от долей пикселя, на которые сдвинулась сетка столбцов.
  const flat = (s: Sample, c: number) => {
    const [a, b, y] = [s.ys[c - 1], s.ys[c + 1], s.ys[c]];
    return a != null && b != null && y != null && Math.abs(a - y) <= 1 && Math.abs(b - y) <= 1;
  };
  const moved: number[] = [];
  let worst = { dy: 0, t: 0, early: 0, late: 0 };
  for (let i = 0; i < samples.length; i++)
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      for (let c = 0; c < b.w; c++) {
        const yb = b.ys[c];
        if (yb == null || !flat(b, c)) continue;
        const t = b.left + ((c + 0.5) / b.w) * b.span;
        if (t > a.now - 0.25 || t < a.left) continue;
        const ca = ((t - a.left) / a.span) * a.w - 0.5;
        const near = Math.round(ca);
        if (Math.abs(near - ca) > 0.3) continue;
        const ya = a.ys[near];
        if (ya == null || !flat(a, near)) continue;
        const dy = Math.abs(yb - ya);
        moved.push(dy);
        if (dy > worst.dy) worst = { dy, t, early: a.now, late: b.now };
      }
    }
  moved.sort((x, y) => x - y);
  const p95 = moved[Math.floor(moved.length * 0.95)] ?? 0;
  const semitone = samples[0].semitone;
  console.log(`сравнено столбцов: ${moved.length}, p95 ${p95.toFixed(2)} px, худший ${worst.dy.toFixed(1)} px (секунда ${worst.t.toFixed(2)} на снимках ${worst.early.toFixed(2)} и ${worst.late.toFixed(2)}), полутон ${semitone.toFixed(1)} px`);
  expect(moved.length, "одни и те же секунды видны на нескольких снимках").toBeGreaterThan(200);
  expect(p95, `уже нарисованная линия не сдвигается (p95 ${p95.toFixed(2)} px, полутон ${semitone.toFixed(1)} px)`).toBeLessThanOrEqual(2);
  expect(worst.dy, `ни один столбец не сдвинулся на полутон (худший ${worst.dy.toFixed(1)} px в секунде ${worst.t.toFixed(2)})`).toBeLessThan(semitone);

  // Новая тональность принята: в последнем снимке свежие точки (последние 0,8 с) снова у эталона.
  const last = samples.at(-1)!;
  let fresh = 0, onRef = 0;
  for (let c = 0; c < last.w; c++) {
    const t = last.left + ((c + 0.5) / last.w) * last.span;
    const y = last.ys[c];
    const r = last.ref[c];
    if (y == null || r == null || t < last.now - 0.8) continue;
    fresh++;
    if (Math.abs(y - r) <= 1.5 * last.semitone + 3) onRef++;
  }
  expect(fresh, "в конце есть свежие точки своей линии").toBeGreaterThan(20);
  expect(onRef / fresh, `после смены тональности новые точки у эталона (${onRef}/${fresh})`).toBeGreaterThanOrEqual(0.8);
});
