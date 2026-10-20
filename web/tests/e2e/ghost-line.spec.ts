// Пение против своего рекорда: синий пунктир призрака виден на сцене и на графике итога.
// Владелец (скрин 18-19): в легенде «Твой рекорд (призрак)», а пунктира нет ни при пении,
// ни на экране после песни. Пунктир ищется по пикселям цвета соперника на холсте.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeMic } from "./fake-mic";

const SONG = "cn-earth";
const reference = JSON.parse(readFileSync(new URL(`../../static/songs/${SONG}/reference.json`, import.meta.url), "utf8")) as { duration_s: number; f0_midi: (number | null)[] };

/** Рекорд: та же мелодия на 3 полутона выше, на сетке 50 мс (как сохраняет rememberBest). */
function recordCurve() {
  const n = Math.ceil(reference.duration_s / 0.05);
  return Array.from({ length: n }, (_, i) => {
    const m = reference.f0_midi[Math.min(reference.f0_midi.length - 1, i * 5)];
    return { t: i * 0.05, midi: m === null ? null : Math.round((m + 3) * 10) / 10 };
  });
}

/** Сколько пикселей холста окрашено цветом CSS-переменной (±24 по каждому каналу). */
function colored(page: Page, selector: string, variable: string) {
  return page.evaluate(({ selector, variable }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)!;
    const hex = getComputedStyle(canvas).getPropertyValue(variable).trim();
    const probe = document.createElement("canvas").getContext("2d")!;
    probe.fillStyle = hex;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let k = 0; k < data.length; k += 4)
      if (data[k + 3] > 120 && Math.abs(data[k] - r) <= 24 && Math.abs(data[k + 1] - g) <= 24 && Math.abs(data[k + 2] - b) <= 24) n++;
    return n;
  }, { selector, variable });
}

test("против своего рекорда: пунктир призрака на сцене и на графике итога", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.addInitScript(({ id, curve }) => {
    localStorage.setItem(`perepev.best.${id}`, JSON.stringify({ score: 50, curve, at: "2026-10-17T00:00:00.000Z" }));
  }, { id: SONG, curve: recordCurve() });
  await fakeMic(context, SONG, { shift: -2 });
  await page.goto(`/sing/${SONG}`);
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("checkbox", { name: /Против своего рекорда/ }).check();
  await expect(page.getByText(/Против призрака: Твой рекорд/)).toBeVisible();
  const go = page.getByRole("button", { name: "Начать пение" });
  await expect(go).toBeEnabled({ timeout: 20_000 });
  await go.click();
  await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
  await page.waitForTimeout(6_000);
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/ghost-stage.png", style: ".stage .overlay { display: none !important; }" });
  const onStage = await colored(page, ".stage .screen canvas", "--stage-rival");
  expect(onStage, "пунктир призрака на сцене").toBeGreaterThan(150);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page).toHaveURL(/\/result$/, { timeout: 60_000 });
  await expect(page.getByText("Дуэль с призраком: рейтинг не меняется")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/ghost-result.png" });
  const onResult = await colored(page, "#analysis .trace canvas", "--rival");
  expect(onResult, "пунктир призрака на графике итога").toBeGreaterThan(150);
});
