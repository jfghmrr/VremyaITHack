// Уведомления о сторонних компонентах, которые попадают в поставку:
// npm-зависимости сайта (без dev) и Rust-crate'ы сервера и WASM-ядра.
// node tools/notices.mjs → THIRD_PARTY_NOTICES.txt и web/static/THIRD_PARTY_NOTICES.txt
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const licenseFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f) && statSync(join(dir, f)).isFile()) : [];
let text = "THIRD-PARTY NOTICES / УВЕДОМЛЕНИЯ О СТОРОННИХ КОМПОНЕНТАХ\nСформировано tools/notices.mjs из зафиксированных lock-файлов.\n";

// Шрифты: все из google/fonts под SIL Open Font License 1.1, у каждого свой текст лицензии.
const fonts = [
  ["Golos Text (Paratype)", "GolosText-OFL.txt"],
  ["Caveat", "Caveat-OFL.txt"],
  ["IBM Plex Mono", "IBMPlexMono-OFL.txt"],
  ["Oswald", "Oswald-OFL.txt"],
  ["PT Serif (ParaType)", "PTSerif-OFL.txt"],
  ["Rubik Mono One", "RubikMonoOne-OFL.txt"],
];
text += "\n\n######## Шрифты ########";
for (const [name, file] of fonts) text += `\n\n${name}, SIL Open Font License 1.1\n\n` + readFileSync(join(root, "web/static/fonts", file), "utf8");

text += "\n\n######## npm (сайт) ########\n";
const lock = JSON.parse(readFileSync(join(root, "web/package-lock.json"), "utf8"));
for (const [folder, pkg] of Object.entries(lock.packages)) {
  if (!folder || pkg.dev || pkg.optional || pkg.devOptional) continue;
  const dir = join(root, "web", folder);
  text += `\n${"=".repeat(72)}\n${folder.replace(/^node_modules\//, "")} ${pkg.version}\nЛицензия: ${pkg.license ?? "см. текст"}\n`;
  for (const f of licenseFiles(dir)) text += `\n${readFileSync(join(dir, f), "utf8")}\n`;
}

text += "\n\n######## Rust (сервер и WASM) ########\n";
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { cwd: root, maxBuffer: 1 << 28, encoding: "utf8" }));
const normal = new Set();
const byId = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const walk = (id) => {
  if (normal.has(id)) return;
  normal.add(id);
  for (const d of byId.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg);
};
for (const id of meta.workspace_members) walk(id);
const pkgs = meta.packages.filter((p) => normal.has(p.id) && !meta.workspace_members.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
for (const p of pkgs) {
  text += `\n${"=".repeat(72)}\n${p.name} ${p.version}\nЛицензия: ${p.license ?? p.license_file ?? "см. текст"}\n`;
  const dir = dirname(p.manifest_path);
  const files = licenseFiles(dir);
  // Для двойных MIT/Apache-2.0 достаточно одного текста; берём MIT, если он есть.
  const chosen = files.find((f) => /mit/i.test(f)) ?? files[0];
  if (chosen) text += `\n${readFileSync(join(dir, chosen), "utf8")}\n`;
}
text = text.replace(/[ \t]+$/gm, "");
writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), text);
writeFileSync(join(root, "web/static/THIRD_PARTY_NOTICES.txt"), text);
console.log(`npm: ${Object.keys(lock.packages).length} записей lock, Rust: ${pkgs.length} crate'ов; ${(text.length / 1024).toFixed(0)} КиБ`);
