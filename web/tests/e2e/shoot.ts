// Ключевые сцены вместе с подвалом помещаются в настольное окно.
// На узком экране допускается вертикальная прокрутка; документы читаются целиком.
import { expect, type Page } from "@playwright/test";

export async function shoot(page: Page, name: string, sizes: [number, number][] = [[1366, 768], [1920, 1080], [800, 768]], _fullPage = false) {
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    await page.screenshot({ path: `../docs/screens/${name}-${w}.png`, fullPage: _fullPage || w < 1366 });
    if (w >= 1366 && !_fullPage) expect(box.sh, `${name} ${w}: вертикальная прокрутка`).toBeLessThanOrEqual(h);
    expect(box.sw, `${name} ${w}: горизонтальная прокрутка`).toBeLessThanOrEqual(w);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
}
