// Собирает scoring-wasm и генерирует привязки wasm-bindgen в src/lib/wasm (не хранится в Git).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../..", import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("cargo", ["build", "--release", "-p", "scoring-wasm", "--target", "wasm32-unknown-unknown"]);
run("wasm-bindgen", [
  "--target", "web",
  "--out-dir", join(root, "web/src/lib/wasm"),
  "--out-name", "scoring",
  join(root, "target/wasm32-unknown-unknown/release/scoring_wasm.wasm"),
]);
