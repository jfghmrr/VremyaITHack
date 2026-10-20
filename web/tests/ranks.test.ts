// Лестница рангов на странице дуэлей повторяет пороги сервера (crates/api/src/ratings.rs, fn rank):
// подсказка не должна расходиться с рангом, который сервер присылает игроку.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CALIBRATION_DEFAULT, RANKS, rankRange } from "../src/lib/duel/ranks";

it("ранги и пороги MMR совпадают с сервером", () => {
  const rust = readFileSync(new URL("../../crates/api/src/ratings.rs", import.meta.url), "utf8");
  const body = rust.slice(rust.indexOf("pub fn rank("), rust.indexOf("}", rust.indexOf("pub fn rank(")));
  const bounded = [...body.matchAll(/m if m < (\d+(?:\.\d+)?) => "([^"]+)"/g)].map((m) => ({ below: Number(m[1]), name: m[2] }));
  const last = body.match(/_ => "([^"]+)"/)?.[1];
  expect(bounded.length).toBeGreaterThan(0);
  // Сервер: имя i-й ступени действует ниже порога i; следующая ступень начинается с него.
  const server = [{ name: bounded[0].name, from: null as number | null }, ...bounded.slice(1).map((b, i) => ({ name: b.name, from: bounded[i].below })), { name: last, from: bounded.at(-1)!.below }];
  expect(RANKS).toEqual(server);
});

it("подписи диапазонов", () => {
  expect(RANKS.map((_, i) => rankRange(i))).toEqual(["до 1000", "от 1000", "от 1200", "от 1400", "от 1600"]);
});

it("калибровка по умолчанию — столько же дуэлей, сколько в GameConfig сервера", () => {
  const rust = readFileSync(new URL("../../crates/api/src/config.rs", import.meta.url), "utf8");
  const values = [...rust.matchAll(/calibration_matches: (\d+),/g)].map((m) => Number(m[1]));
  // Одно значение по умолчанию в impl Default for GameConfig.
  expect(values).toEqual([CALIBRATION_DEFAULT]);
});
