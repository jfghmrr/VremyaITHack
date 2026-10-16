import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fakeMic, type MicOptions } from "./fake-mic";
import { documents } from "../../src/lib/legal/operator";

export const password = "Long-demo-pass-2026";

/** Состояние браузера с уже принятыми уведомлением о cookie и согласием на запись голоса (для новых контекстов). */
export const accepted = () => {
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:4173";
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: "perepev.cookies", value: "test" }, { name: "perepev.voiceConsent", value: documents.consent }] }],
  };
};

/** Новый пользователь через API (тот же Origin, что у сайта) и страница с его сессией. */
export async function player(browser: Browser, name: string, song: string, mic: MicOptions): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const context = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"], storageState: accepted() });
  await fakeMic(context, song, mic);
  const page = await context.newPage();
  await page.goto("/");
  const email = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const r = await page.evaluate(
    async ({ email, name, password }) => {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-perepev-request": "1" },
        body: JSON.stringify({ email, name, password, consent: true, ageGroup: "14plus" }),
      });
      return res.status;
    },
    { email, name, password },
  );
  expect(r).toBe(201);
  await page.reload();
  return { context, page, email };
}
