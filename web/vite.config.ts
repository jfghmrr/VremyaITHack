import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    sveltekit({
      // Статическая сборка: публичные страницы пререндерятся, игровые маршруты
      // открываются через fallback и работают как клиентские экраны.
      adapter: adapter({ fallback: "200.html", precompress: false, strict: true }),
      // CSP с хешами встроенных скриптов (страницы пререндерятся). WASM требует
      // wasm-unsafe-eval; style-src допускает inline для атрибутов style в разметке.
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["self"],
          "script-src": ["self", "wasm-unsafe-eval"],
          "style-src": ["self", "unsafe-inline"],
          "img-src": ["self", "data:"],
          "media-src": ["self", "blob:"],
          "connect-src": ["self"],
          "worker-src": ["self"],
          "font-src": ["self"],
          "object-src": ["none"],
          "base-uri": ["self"],
          "form-action": ["self"],
        },
      },
    }),
  ],
  server: {
    proxy: { "/api": { target: process.env.API_URL ?? "http://127.0.0.1:3001", ws: true } },
  },
  preview: {
    proxy: { "/api": { target: process.env.API_URL ?? "http://127.0.0.1:3001", ws: true } },
  },
  // Ассеты не встраиваются data:-URL: модуль AudioWorklet должен грузиться со своего
  // источника, иначе его заблокирует CSP.
  build: { assetsInlineLimit: 0 },
  test: { include: ["tests/*.test.ts"] },
});
