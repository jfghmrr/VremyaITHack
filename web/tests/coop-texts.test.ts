// «Вместе», голос партнёру: везде, где человек решает, сказано одно и то же — снять согласие
// можно в любой момент и после песни, копия на сервере удаляется сразу, а запись, которую
// открытая страница партнёра уже загрузила, остаётся в ней, пока партнёр не закроет страницу.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const files = {
  "согласие": "../src/routes/legal/consent/+page.svelte",
  "политика": "../src/routes/legal/privacy/+page.svelte",
  "подготовка матча": "../src/routes/duels/match/[id]/+page.svelte",
  "итог «Вместе»": "../src/lib/duel/CoopResult.svelte",
};

it.each(Object.entries(files))("%s: снятие в любой момент, копия на сервере удаляется сразу, загруженное страницей партнёра остаётся в ней", (_, path) => {
  const text = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
  expect(text).toMatch(/в любой момент/);
  expect(text).toMatch(/копия на сервере удал(яе|и)тся сразу/i);
  expect(text).toMatch(/пока партн[её]р не закроет страницу/);
});
