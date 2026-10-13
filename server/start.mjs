import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "./app.mjs";
const dbPath = process.env.DB_PATH || "data/perepev.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const app = createServer({
  dbPath,
  origins: (
    process.env.APP_ORIGINS ||
    "http://localhost:8080,http://127.0.0.1:5173,http://localhost:5173"
  ).split(","),
  secureCookies: process.env.COOKIE_SECURE === "true",
});
await app.listen({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
console.log("Кабинет: сервер готов");
