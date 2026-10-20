import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { artDims, artSizes } from "../src/lib/brand/art";

/** Ширина и высота WebP из заголовка (VP8X, VP8L или VP8). */
function webpSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect(b.toString("ascii", 0, 4) + b.toString("ascii", 8, 12)).toBe("RIFFWEBP");
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (chunk === "VP8L") { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  throw new Error(`${path}: неизвестный формат ${chunk}`);
}

it("размеры в таблице совпадают с файлами графики: место под картинку резервируется точно", () => {
  const names = Object.keys(artSizes);
  expect(names.length).toBeGreaterThan(20);
  for (const name of names) expect([name, ...webpSize(`static/art/${name}.webp`)]).toEqual([name, ...artSizes[name]]);
});

it("атрибуты width/height только для известных файлов", () => {
  expect(artDims("furniture/armchair")).toEqual({ width: 800, height: 811 });
  expect(artDims("no/such-file")).toEqual({});
});

it("иконки сайта сжаты палитрой без смены размера (icon-192 Chrome берёт при первом визите)", () => {
  for (const [file, side] of [["icon-192.png", 192], ["apple-touch-icon.png", 180]] as const) {
    const b = readFileSync(`static/${file}`);
    expect(b.toString("ascii", 1, 4)).toBe("PNG");
    expect([file, b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([file, side, side]);
    expect(b.length, file).toBeLessThan(8 * 1024);
  }
});
