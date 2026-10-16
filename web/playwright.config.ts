import { defineConfig } from "@playwright/test";
import { documents } from "./src/lib/legal/operator";

// Изолированный Chromium с синтетическим микрофоном (tests/e2e/fake-mic.ts).
// Сайт: собранный frontend (vite preview) с прокси /api на запущенный Rust API.
const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    // Уведомление о cookie и согласие на запись голоса уже приняты; отдельные сценарии проверяют их показ.
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage: [{ name: "perepev.cookies", value: "test" }, { name: "perepev.voiceConsent", value: documents.consent }] }],
    },
    viewport: { width: 1366, height: 768 },
  },
  projects: [
    {
      // Основной прогон: все сценарии, синтетический микрофон и флаги медиа Chromium.
      name: "chromium",
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: { args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
        permissions: ["microphone", "clipboard-read", "clipboard-write"],
      },
    },
    {
      // Эмуляция Safari (телефоны — isMobile и hasTouch в самих сценариях): матрица
      // устройств и страница ошибки. Синтетический микрофон подменяет getUserMedia в
      // странице и не требует флагов Chromium, поэтому пение проверяется и здесь.
      name: "webkit",
      testMatch: ["responsive.spec.ts", "error-page.spec.ts"],
      use: { browserName: "webkit" },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "npx vite preview --host 127.0.0.1 --port 4173", port: 4173, reuseExistingServer: true },
});
