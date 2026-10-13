import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
let text =
  "THIRD-PARTY PRODUCTION DEPENDENCY NOTICES\nGenerated from the pinned npm lockfile.\n";
for (const [folder, pkg] of Object.entries(lock.packages)) {
  if (!folder || pkg.dev || pkg.optional) continue;
  const files = (await readdir(folder)).filter((f) =>
    /^licen[sc]e(?:\.|$)/i.test(f),
  );
  text += `\n${"=".repeat(72)}\n${folder.replace(/^node_modules\//, "")} ${pkg.version}\nDeclared license: ${pkg.license ?? "See license text"}\n`;
  for (const file of files)
    text += `\n${await readFile(path.join(folder, file), "utf8")}\n`;
  if (!files.length) {
    const readme = await readFile(path.join(folder, "README.md"), "utf8");
    const at = readme.search(/^#+ LICENSE/m);
    if (at < 0) throw new Error(`No license text: ${folder}`);
    text += readme.slice(at) + "\n";
  }
}
await writeFile("THIRD_PARTY_NOTICES.txt", text);
await writeFile("public/THIRD_PARTY_NOTICES.txt", text);
console.log("Production dependency notices written.");
