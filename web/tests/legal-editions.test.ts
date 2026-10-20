// Редакции документов: согласие и политика обновлены вместе с режимом «Вместе» (голос партнёру).
// Версия согласия клиента — она же отметка согласия на запись голоса — совпадает с сервером.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { documents } from "../src/lib/legal/operator";

it("согласие и политика — редакция 18 октября 2026; версия согласия та же, что на сервере", () => {
  expect(documents.consent).toBe("2026-10-18");
  expect(documents.privacy).toBe("18 октября 2026");
  // Документы без изменений сохраняют прежнюю редакцию.
  expect([documents.cookies, documents.terms, documents.contacts]).toEqual(["17 октября 2026", "17 октября 2026", "17 октября 2026"]);
  const rust = readFileSync(new URL("../../crates/api/src/accounts.rs", import.meta.url), "utf8");
  expect(rust.match(/pub const CONSENT_VERSION: &str = "([^"]+)";/)?.[1]).toBe(documents.consent);
});
