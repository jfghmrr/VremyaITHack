import { expect, test } from "@playwright/test";
import { player, password } from "./helpers";
import { fakeMic } from "./fake-mic";
import { shoot } from "./shoot";
import { readFileSync } from "node:fs";
import type { CatalogEntry } from "../../src/lib/catalog";

const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL("../../static/songs/index.json", import.meta.url), "utf8"));

test("комната: шкафчики, звезда и магнитофон работают с мышью и клавиатурой", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const hydrated = page.waitForResponse(r => r.url().endsWith("/api/me"));
  await page.goto("/"); await hydrated;
  for (const name of ["Зажечь звезду", "Погладить кота"]) {
    const button = page.getByRole("button", { name, exact: true });
    const before = await button.getAttribute("aria-pressed");
    await button.click(); await expect(button).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
    await button.click(); await expect(button).toHaveAttribute("aria-pressed", before!);
  }
  await page.getByRole("button", { name: "Послушать песню", exact: true }).click();
  await expect(page.getByRole("button", { name: "Остановить песню" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Остановить песню" }).click();
  await expect(page.getByRole("button", {name:"Настольная лампа"})).toHaveCount(0);
  for (const [index, target] of ["friends", "progress"].entries()) {
    const locker = page.locator(".locker").nth(index), door = locker.locator(".door");
    await locker.hover();
    await expect(door).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(850);
    const rotation = await door.evaluate(e => new DOMMatrix(getComputedStyle(e).transform).m11);
    expect(rotation).toBeGreaterThan(0);
    expect(rotation).toBeLessThan(.1); // right hinge, almost edge-on; no overlap with adjacent locker
    expect(await door.evaluate(e=>parseFloat(getComputedStyle(e).transformOrigin))).toBeGreaterThan(50);
    await locker.locator(".inside a").click({trial:true});
    await page.mouse.move(5,5);
    await expect(door).toHaveAttribute("aria-expanded", "false");
    await door.focus(); await expect(door).toHaveAttribute("aria-expanded","true");
    await page.keyboard.press("Enter"); await expect(page).toHaveURL(new RegExp(`/${target}$`));
    await page.goto("/");
  }
  expect(await page.getByRole("link", { name: "Начать петь" }).evaluate(e => getComputedStyle(e).cursor)).toContain("data:image/svg+xml");
  expect(errors).toEqual([]);
});

test("поиск не считается вызовом, стрелки и прослушивание каталога работают", async ({ page }) => {
  await page.goto("/"); await page.getByRole("link", { name: "Поиск песни", exact: true }).click();
  await expect(page.getByRole("searchbox")).toBeFocused();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("searchbox").fill("несуществующая песня");
  await expect(page.getByText("Ничего не нашлось.", { exact: false })).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await expect(page.getByRole("group", { name: "Песни", exact: true }).getByRole("radio")).toHaveCount(catalog.length);
  await expect(page.getByRole("button", { name: `Петь «${catalog[0].title}»` })).toBeEnabled();
  await page.getByRole("button", { name: "Следующая песня" }).click();
  await expect(page.getByRole("button", { name: `Петь «${catalog[1].title}»` })).toBeEnabled();
  await page.getByRole("button", { name: "Предыдущая песня" }).click();
  await page.getByRole("button", { name: `Послушать «${catalog[0].title}»` }).click();
  await expect(page.locator(".cassette.spinning")).toBeVisible();
  await page.getByRole("button", { name: `Остановить «${catalog[0].title}»` }).click();
  await shoot(page, "catalog-final");
});

test("комната друга: выход кнопкой, навигацией и возврат без зацикливания", async ({ browser }) => {
  const a = await player(browser, "Выход", "cn-earth", {});
  await a.page.goto("/duels");
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  await a.page.getByRole("button", { name: "Скопировать ссылку" }).click();
  await expect(a.page.getByText("Ссылка скопирована")).toBeVisible();
  await a.page.getByRole("button", { name: "← Выйти из комнаты" }).click();
  await expect(a.page).toHaveURL(/\/duels$/);
  await expect(a.page.getByRole("button", { name: "Создать комнату" })).toBeEnabled();
  await a.page.waitForTimeout(1500); await expect(a.page).toHaveURL(/\/duels$/);
  await a.page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(a.page.getByRole("heading", { name: "Ждём друга" })).toBeVisible();
  await a.page.getByRole("link", { name: "Песни", exact: true }).click();
  await expect(a.page).toHaveURL(/\/songs$/);
  await a.page.getByRole("link", { name: "Дуэли", exact: true }).click();
  await expect(a.page.getByRole("button", { name: "Создать комнату" })).toBeEnabled();
  await a.context.close();
});

test("кабинет: оба разворота, имя и смена пароля", async ({ browser }) => {
  const a = await player(browser, "Тетрадь", "cn-earth", {});
  await a.page.goto("/progress");
  await shoot(a.page, "progress-final", [[1366,768],[1920,1080],[800,768]]);
  await a.page.getByRole("link", {name:"Настройки аккаунта ↗"}).click();
  await a.page.getByLabel("Имя в игре (видно другим игрокам)").fill("Музыкальный кот");
  await a.page.getByRole("button", { name: "Сохранить имя" }).click();
  await expect(a.page.getByRole("heading", { name: "Музыкальный кот" })).toBeVisible();
  await a.page.getByLabel("Текущий пароль", { exact: true }).fill(password);
  const next = `${password}-updated`;
  await a.page.getByLabel("Новый пароль", { exact: true }).fill(next);
  await a.page.getByRole("button", { name: "Сменить пароль" }).click();
  await expect(a.page.getByRole("status")).toContainText("Пароль");
  await a.page.getByRole("button", { name: "Выйти из кабинета" }).click();
  await a.page.getByLabel("Почта", { exact: true }).fill(a.email);
  await a.page.getByLabel("Пароль", { exact: true }).fill(next);
  await a.page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(a.page.getByRole("heading", { name: "Музыкальный кот" })).toBeVisible();
  await a.context.close();
});

test("голосовая шкала: плавное рисование, выбор входа и неподвижная страница", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  await fakeMic(context, "cn-earth", { shift: -5 });
  await page.goto("/sing/cn-earth");
  await page.getByRole("button", { name: "Включить микрофон" }).click();
  await page.getByRole("combobox", { name: "Устройство ввода" }).selectOption("usb-headset");
  await expect(page.getByRole("button", { name: "Начать пение" })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("perepev.inputDeviceId"))).toBe("usb-headset");
  await page.getByRole("button", { name: "Начать пение" }).click();
  await expect(page.getByLabel("Пение", { exact: true })).toBeVisible();
  const performanceSample = await page.evaluate(() => new Promise<{p95: number; mean: number; frames: number}>(resolve => {
    const timings: number[] = []; let previous = 0;
    const step = (now: number) => { if (previous) timings.push(now - previous); previous = now;
      if (timings.length < 240) requestAnimationFrame(step);
      else { const sorted = [...timings].sort((a,b)=>a-b); resolve({p95: sorted[Math.floor(sorted.length * .95)], mean: timings.reduce((a,b)=>a+b,0)/timings.length, frames: timings.length}); }
    }; requestAnimationFrame(step);
  }));
  console.info("Интервалы кадров, мс:", JSON.stringify(performanceSample));
  await info.attach("render-timing", {body: JSON.stringify(performanceSample),contentType:"application/json"});
  expect(performanceSample.p95).toBeLessThan(100);
  expect(await page.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight}))).toEqual({y:0,h:768});
  await page.keyboard.press("Escape"); await page.getByRole("dialog").getByRole("button", {name:/^Выйти/}).click();
  await expect(page).toHaveURL(/\/songs$/);
});


test("главная: магнитофон и кнопки не перекрываются на широком и узком экране", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.emulateMedia({reducedMotion:"reduce"});
  for (const [width,height] of [[1366,768],[1920,1080],[800,768],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(250);
    const deck=await page.locator(".boombox").boundingBox();
    const preview=await page.getByRole("button",{name:"Включить магнитофон",exact:true}).boundingBox();
    const start=await page.getByRole("link",{name:"Начать петь",exact:false}).boundingBox();
    expect(preview!.y).toBeGreaterThanOrEqual(deck!.y);
    expect(preview!.y+preview!.height).toBeLessThanOrEqual(deck!.y+deck!.height);
    expect(start!.y).toBeGreaterThanOrEqual(deck!.y+deck!.height);
    const overlap=Math.min(preview!.x+preview!.width,start!.x+start!.width)>Math.max(preview!.x,start!.x) && Math.min(preview!.y+preview!.height,start!.y+start!.height)>Math.max(preview!.y,start!.y);
    expect(overlap).toBe(false);
    const box=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));
    expect(box.w).toBeLessThanOrEqual(width);
    if(width>=1366) expect(box.h).toBeLessThanOrEqual(height);
    await page.screenshot({path:`../docs/screens/home-controls-${width}.png`,fullPage:width<1366});
    await page.locator(".locker .door").first().focus();
    await page.locator(".locker").nth(1).hover();
    await page.waitForTimeout(850);
    for (const locker of await page.locator(".locker").all()) {
      await locker.locator(".inside a").click({trial:true});
      const body=await locker.locator(".body").boundingBox();
      const paper=await locker.locator(".inside").boundingBox();
      expect(paper!.width).toBeGreaterThanOrEqual(body!.width-10);
      expect(paper!.height).toBeGreaterThanOrEqual(body!.height-10);
    }
    const openBox=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));
    expect(openBox.w).toBeLessThanOrEqual(width);
    if(width>=1366) expect(openBox.h).toBeLessThanOrEqual(height);
    await page.screenshot({path:`../docs/screens/home-lockers-open-${width}.png`,fullPage:width<1366});
    await page.getByRole("link", {name:"Начать петь"}).focus();
    await page.mouse.move(5,5);
  }
});
