// Генерирует src/lib/api/types.ts из JSON-схем в contracts/ (их создаёт `perepev-api schemas`).
// CI запускает этот скрипт и проверяет, что файл не изменился.
import { compileFromFile } from "json-schema-to-typescript";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../../contracts/", import.meta.url));
const parts = ["// Сгенерировано scripts/gen-types.mjs из contracts/*.schema.json. Не редактировать вручную.\n"];
const seen = new Set();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort()) {
  let ts = await compileFromFile(dir + file, { bannerComment: "", additionalProperties: false, strictIndexSignatures: true });
  // Общие определения встречаются в нескольких схемах: оставляем первое объявление.
  ts = ts
    .split(/\n(?=export )/)
    .filter((block) => {
      const name = block.match(/^export (?:interface|type) (\w+)/)?.[1];
      if (!name) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .join("\n");
  parts.push(ts.trim() + "\n");
}
writeFileSync(fileURLToPath(new URL("../src/lib/api/types.ts", import.meta.url)), parts.join("\n"));
