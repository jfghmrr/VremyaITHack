// Стенд «Вместе» с настоящими голосами для e2e: две страницы с согласием, зонд звука на итоге
// (что звучит, когда смолкает, какие контексты закрыты) и ручки для гонок (задержка запуска
// контекста, удержание отправки партнёра). Сценарии — coop-voices.spec.ts и coop-handover.spec.ts
// (в двух файлах: регистрация ограничена 12 за 15 минут с адреса, а каждый сценарий — два игрока).
import { devices, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { player } from "./helpers";

export const shots = process.env.COOP_SHOTS ?? "test-results/coop";
mkdirSync(shots, { recursive: true });
const { defaultBrowserType: _, ...iphoneProfile } = devices["iPhone 13"];
export const iphone = iphoneProfile;
export const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
export const SONG = "cn-earth";
export const VOICE_PUT = /\/api\/matches\/[^/]+\/voice$/;

/**
 * Узел звука на итоге: kind — синтезированный голос (пилообразный генератор, curve-voice.ts),
 * настоящий голос (буфер 16 кГц, VoiceMix) или минус (буфер длиннее 5 с); ctx — номер контекста;
 * start / end — по часам контекста (end — последний вызов stop или конец буфера).
 */
export type Play = { kind: "synth" | "real" | "backing"; ctx: number; peak?: number; start: number; end: number; at: number };

/**
 * Что страница реально играет и когда это смолкает. Плюс две ручки для гонок:
 * `__slowResume` (мс) — первый resume() ещё не задержанного контекста ждёт столько; `__voiceAt` —
 * performance.now(), когда пришла запись партнёра или своя (GET …/voice/N с ответом 200).
 */
export async function probe(page: Page) {
  await page.context().addInitScript(() => {
    type Rec = { kind: "synth" | "real" | "backing"; ctx: number; peak?: number; start: number; dur: number; stops: number[]; at: number };
    const w = window as unknown as { __recs: Rec[]; __closed: number[]; __slowResume: number; __resumeWaits: number; __voiceAt: number[] };
    w.__recs = [];
    w.__closed = [];
    w.__slowResume = 0;
    w.__resumeWaits = 0;
    w.__voiceAt = [];
    const ids = new WeakMap<BaseAudioContext, number>();
    let next = 0;
    const id = (c: BaseAudioContext) => ids.get(c) ?? (ids.set(c, ++next), next);
    const nodes = new WeakMap<AudioScheduledSourceNode, Rec>();
    const track = (node: AudioScheduledSourceNode, kind: Rec["kind"], when: number | undefined, dur: number, peak?: number) => {
      const rec: Rec = { kind, ctx: id(node.context), peak, start: Math.max(when ?? 0, node.context.currentTime), dur, stops: [], at: performance.now() };
      nodes.set(node, rec);
      w.__recs.push(rec);
    };
    const os = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
      if (this.type === "sawtooth") track(this, "synth", when, Infinity);
      return os.call(this, when);
    };
    const bs = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when?: number, offset?: number, duration?: number) {
      const b = this.buffer;
      const dur = duration ?? (b ? b.duration - (offset ?? 0) : Infinity);
      if (b?.sampleRate === 16000) {
        const data = b.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i += 7) peak = Math.max(peak, Math.abs(data[i]));
        track(this, "real", when, dur, peak);
      } else if (b && b.duration > 5) track(this, "backing", when, dur);
      return bs.call(this, when, offset, duration);
    };
    const ss = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.stop = function (this: AudioScheduledSourceNode, when?: number) {
      nodes.get(this)?.stops.push(Math.max(when ?? 0, this.context.currentTime));
      return ss.call(this, when);
    };
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function (this: AudioContext) {
      w.__closed.push(id(this));
      return close.call(this);
    };
    // Медленный запуск контекста: все resume() контекста, впервые запущенного при включённой
    // задержке, ждут одно и то же окончание задержки (как контекст, который долго стартует).
    const slowed = new WeakMap<BaseAudioContext, Promise<void>>();
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = async function (this: AudioContext) {
      let ready = slowed.get(this);
      if (!ready && w.__slowResume) {
        w.__resumeWaits++;
        ready = new Promise<void>((r) => setTimeout(r, w.__slowResume));
        slowed.set(this, ready);
      }
      if (ready) await ready;
      return resume.call(this);
    };
    // Минус итога декодируется в OfflineAudioContext (CoopResult): пока он не готов, прослушивание
    // идёт без минуса, а проверка «без паузы минуса» ему нужна.
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    (w as unknown as { __instrumental: boolean }).__instrumental = false;
    OfflineAudioContext.prototype.decodeAudioData = async function (this: OfflineAudioContext, data: ArrayBuffer) {
      const b = await decode.call(this, data);
      if (b.duration > 5) (w as unknown as { __instrumental: boolean }).__instrumental = true;
      return b;
    } as typeof OfflineAudioContext.prototype.decodeAudioData;
    const f = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const r = await f(...args);
      if (r.ok && /\/voice\/\d$/.test(r.url)) w.__voiceAt.push(performance.now());
      return r;
    };
  });
}
/** Минус итога готов: прослушивание пойдёт с минусом. */
export async function instrumentalReady(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __instrumental: boolean }).__instrumental), { timeout: 15_000 }).toBe(true);
}

/** Узлы звука с моментом, когда каждый смолкает. */
export const plays = (page: Page): Promise<Play[]> =>
  page.evaluate(() =>
    (window as unknown as { __recs: { kind: Play["kind"]; ctx: number; peak?: number; start: number; dur: number; stops: number[]; at: number }[] }).__recs.map((r) => ({
      kind: r.kind,
      ctx: r.ctx,
      peak: r.peak,
      start: r.start,
      at: r.at,
      end: Math.min(r.stops.length ? r.stops[r.stops.length - 1] : Infinity, r.start + r.dur),
    })),
  );
export const closed = (page: Page) => page.evaluate(() => (window as unknown as { __closed: number[] }).__closed);

/**
 * Передача без двойного звучания и без паузы: на контексте сведения каждый синтезированный голос
 * и минус синтеза смолкают ровно в момент старта сведения.
 */
export function handedOverCleanly(all: Play[]) {
  const real = all.filter((p) => p.kind === "real");
  expect(real, "две записи в сведении").toHaveLength(2);
  const ctx = real[0].ctx;
  const mixStart = Math.min(...real.map((p) => p.start));
  const synth = all.filter((p) => p.kind === "synth" && p.ctx === ctx);
  expect(synth.length, "синтез звучал на том же контексте").toBeGreaterThan(0);
  for (const p of synth) expect(p.end, "синтезированный голос смолк к старту сведения").toBeLessThanOrEqual(mixStart + 0.003);
  const backings = all.filter((p) => p.kind === "backing" && p.ctx === ctx).sort((x, y) => x.start - y.start);
  expect(backings, "минус синтеза, затем минус сведения").toHaveLength(2);
  expect(Math.abs(backings[0].end - backings[1].start), "минус без паузы и без наложения").toBeLessThan(0.003);
  expect(backings[1].start).toBeCloseTo(mixStart, 2);
}

/** Оба певца с согласием поделиться голосом на «Подготовке» комнаты «Вместе». */
export async function sharedRoom(A: { browser: Browser; options?: BrowserContextOptions }, B: { browser: Browser; options?: BrowserContextOptions }, before?: (a: Page) => Promise<void>) {
  const a = await player(A.browser, "Вика", SONG, { shift: -3 }, A.options);
  const b = await player(B.browser, "Гоша", SONG, { shift: 5 }, B.options);
  for (const p of [a.page, b.page]) await probe(p);
  await before?.(a.page);
  const errors: string[] = [];
  for (const p of [a.page, b.page]) p.on("pageerror", (e) => errors.push(e.message));
  await a.page.goto("/duels");
  await a.page.locator(".mode.ticket").getByRole("button", { name: "Вместе" }).click();
  await a.page.getByRole("combobox", { name: "Песня", exact: true }).selectOption(SONG);
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  const code = (await a.page.locator(".code").textContent())!.trim();
  await b.page.goto(`/duels/room/${code}`);
  for (const p of [a.page, b.page]) await expect(p.getByRole("heading", { name: "Подготовка" })).toBeVisible({ timeout: 15_000 });
  const share = (p: Page) => p.getByRole("checkbox", { name: /Поделиться голосом с партнёром/ });
  // Согласие — только явное: по умолчанию галочки нет.
  for (const p of [a.page, b.page]) await expect(share(p)).not.toBeChecked();
  await share(a.page).check();
  await share(b.page).check();
  await expect(a.page.getByText("Гоша: согласие есть")).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText("Вика: согласие есть")).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByText("Согласны оба: после песни прозвучат ваши настоящие голоса.")).toBeVisible();
  return { a, b, errors };
}

export async function sing(a: Page, b: Page) {
  for (const p of [a, b]) await p.getByRole("button", { name: "Я готов" }).click();
  for (const p of [a, b]) await expect(p.getByLabel("Пение вместе")).toBeVisible({ timeout: 20_000 });
}

export async function noSideScroll(page: Page, where: string) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${where}: горизонтальная прокрутка`).toBeLessThanOrEqual(page.viewportSize()!.width);
}

export const real = (p: Page) => p.getByRole("button", { name: "Настоящие голоса" });
export const listenButton = (p: Page) => p.getByRole("button", { name: "▶ Прослушать всю песню" });
export const clockOf = (p: Page) => p.locator(".listen .mono");
export const seconds = async (p: Page) => Number((await clockOf(p).textContent())!.split(" / ")[0].replace(",", "."));

/** «Прослушать всю песню» играет настоящие голоса: минус и обе ненулевые записи на одном контексте. */
export async function hearsRealVoices(p: Page, where: string) {
  const before = (await plays(p)).length;
  await listenButton(p).click();
  await expect(clockOf(p)).toHaveText(/\/ 13,9 с$/);
  await expect.poll(() => seconds(p), { timeout: 10_000 }).toBeGreaterThan(1);
  const started = (await plays(p)).slice(before);
  const voices = started.filter((s) => s.kind === "real");
  expect(voices, `${where}: две записи в сведении`).toHaveLength(2);
  for (const v of voices) expect(v.peak, `${where}: запись не тишина`).toBeGreaterThan(0.01);
  expect(started.some((s) => s.kind === "backing" && s.ctx === voices[0].ctx), `${where}: минус на том же контексте`).toBe(true);
  expect(voices[1].ctx, `${where}: одно сведение`).toBe(voices[0].ctx);
  expect(started.filter((s) => s.kind === "synth"), `${where}: без синтезированного голоса`).toEqual([]);
  await expect(p.getByTestId("listen-note")).toHaveText(/^Звучат ваши настоящие голоса/);
  await p.getByRole("button", { name: "■ Стоп" }).click();
  await expect(clockOf(p)).toHaveCount(0);
}

/** Всё на контексте прослушивания смолкло раньше естественного конца, контекст закрыт. */
export async function stoppedEarly(p: Page, ctx: number) {
  await expect.poll(() => closed(p), { message: "контекст прослушивания закрыт" }).toContain(ctx);
  const mine = (await plays(p)).filter((r) => r.ctx === ctx);
  expect(mine.length).toBeGreaterThan(0);
  for (const r of mine) expect(r.end - r.start, `${r.kind} остановлен, а не доигрывает`).toBeLessThan(6);
}

/** Партнёр отправил запись, но PUT держится, пока тест его не отпустит. */
export async function holdPartnerUpload(b: Page) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await b.route(VOICE_PUT, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}
