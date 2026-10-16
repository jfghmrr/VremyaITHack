import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { CatalogEntry } from "../../src/lib/catalog";
import { shoot } from "./shoot";

const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL("../../static/songs/index.json", import.meta.url), "utf8"));

test("магнитофон играет последнюю спетую песню гостя и останавливается при уходе", async ({ page }) => {
  const latest = catalog.find(s => s.id === "cn-earth")!;
  await page.addInitScript(({ first, latest }) => {
    localStorage.setItem("perepev.guestAttempts", JSON.stringify([
      { id: "1", songId: first.id, title: first.title, score: 99, at: "2026-10-16T08:00:00Z" },
      { id: "2", songId: latest.id, title: latest.title, score: 64, at: "2026-10-16T09:00:00Z" },
    ]));
    const Original = window.Audio;
    (window as unknown as { previewAudio: HTMLAudioElement | null }).previewAudio = null;
    window.Audio = function (src?: string) {
      const a = new Original(src);
      (window as unknown as { previewAudio: HTMLAudioElement }).previewAudio = a;
      return a;
    } as unknown as typeof Audio;
  }, { first: catalog[0], latest });
  await page.goto("/");
  await expect(page.locator("#home-preview-track")).toHaveText(`Последняя спетая: ${latest.title}`);
  await page.getByRole("button", { name: "Включить магнитофон", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выключить магнитофон" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => {
    const a = (window as unknown as { previewAudio: HTMLAudioElement }).previewAudio;
    return { playing: !a.paused && a.currentTime > .15, path: new URL(a.currentSrc).pathname };
  })).toEqual({ playing: true, path: `/songs/${latest.id}/backing.mp3` });
  await page.getByRole("link", { name: "Начать петь" }).click();
  // SPA-переход и очистка компонента завершаются после самого клика.
  await expect(page).toHaveURL(/\/songs$/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { previewAudio: HTMLAudioElement }).previewAudio.paused)).toBe(true);
});

test("история аккаунта: более поздняя завершённая дуэль выбирает запись", async ({ page }) => {
  const latest = catalog.find(s => s.id === "jw-as-i-am")!;
  await page.route("**/api/me", r => r.fulfill({ json: { profile: { id: "qa", name: "Тест", email: "qa@example.test" } } }));
  await page.route("**/api/friends", r => r.fulfill({ json: { friends: [], incoming: [], outgoing: [] } }));
  await page.route("**/api/attempts", r => r.fulfill({ json: { attempts: [{ songId: catalog[0].id, score: 95, at: "2026-10-16T08:00:00Z" }] } }));
  await page.route("**/api/matches", r => r.fulfill({ json: { matches: [
    { songId: latest.id, score: 50, at: "2026-10-16T09:00:00Z", state: "finished" },
    { songId: catalog[0].id, score: null, at: "2026-10-16T10:00:00Z", state: "cancelled" },
  ] } }));
  await page.goto("/");
  await expect(page.locator("#home-preview-track")).toHaveText(`Последняя спетая: ${latest.title}`);
});

test("сбой аудио показывает ошибку и разрешает повторное прослушивание", async ({ page }) => {
  await page.route("**/songs/*/backing.mp3", r => r.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Включить магнитофон", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось включить песню");
  await expect(page.getByRole("button", { name: "Включить магнитофон", exact: true })).toBeEnabled();
  await page.unroute("**/songs/*/backing.mp3");
  await page.getByRole("button", { name: "Включить магнитофон", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выключить магнитофон" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("полароид без ссылки, прикреплённая скрепка, чёткий фон и дуэли без кота", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/leaders");
  await expect(page.locator(".second-photo a, a.second-photo")).toHaveCount(0);
  await page.locator(".second-photo").click();
  await expect(page).toHaveURL(/\/leaders$/);
  await shoot(page, "vocal-leaders", [[1366, 768], [390, 844]]);
  await page.goto("/progress");
  for (const [width, height] of [[1366, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const clip = await page.locator(".notebook-clip").boundingBox();
    const book = await page.locator(".spread").boundingBox();
    expect(clip).not.toBeNull(); expect(book).not.toBeNull();
    expect(clip!.x).toBeGreaterThan(book!.x);
    expect(clip!.x + clip!.width).toBeLessThan(book!.x + book!.width);
    expect(clip!.y).toBeLessThan(book!.y + 15);
    expect(clip!.y + clip!.height).toBeGreaterThan(book!.y);
    await expect(page.locator(".wall img")).toHaveAttribute("src", /04-performance/);
    expect(await page.locator(".wall img").evaluate(e => ({ width: (e as HTMLImageElement).naturalWidth, blur: getComputedStyle(e).filter.includes("blur") }))).toEqual({ width: 2560, blur: false });
  }
  await shoot(page, "vocal-progress", [[1366, 768], [390, 844]]);
  await page.goto("/duels");
  await expect(page.locator(".duels .cat, .duels .mascot")).toHaveCount(0);
  await shoot(page, "vocal-duels", [[1366, 768], [390, 844]]);
  expect(errors).toEqual([]);
});
