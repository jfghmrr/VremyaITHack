// Запуск из рабочей копии тега legacy-react-fastify (каталог legacy/), см. tools/fixtures/README.md.
// Эталонная база прежней версии: создаётся её собственным сервером (Fastify + node:sqlite).
import { createServer } from "../../legacy/server/app.mjs";
import { DatabaseSync } from "node:sqlite";
import { rmSync, writeFileSync } from "node:fs";
const db = "../../fixtures/legacy/perepev.sqlite";
rmSync(db, { force: true });
const app = createServer({ dbPath: db });
const h = { origin: "http://localhost:8080", "x-perepev-request": "1" };
const users = [
  { email: "legacy@example.test", name: "Старожил", password: "Legacy-password-2025" },
  { email: "unicode@example.test", name: "Юникод", password: "Пароль-с-юникодом 🎤 2025" },
];
const expected = { users: [] };
for (const [k, u] of users.entries()) {
  const reg = await app.inject({ method: "POST", url: "/api/register", headers: h, payload: { ...u, consent: true } });
  const cookie = reg.headers["set-cookie"].split(";")[0];
  const me = (await app.inject({ url: "/api/me", headers: { cookie } })).json();
  const scores = k === 0 ? [71.5, 88.2] : [55];
  for (const [i, score] of scores.entries())
    await app.inject({ method: "POST", url: "/api/attempts", headers: { ...h, cookie }, payload: {
      id: `00000000-0000-4000-8000-0000000000${k}${i}`, songId: "ode", title: "Ода к радости", score, shift: 2,
      axes: { intervals: 0.8, rhythm: 0.9, stability: 0.7, coverage: 1 }, moments: [], owner: me.profile.id } });
  expected.users.push({ ...u, id: me.profile.id, cookie, scores });
}
await app.close();
// Срок сессий продлевается до 2099 года, чтобы эталон не устаревал.
const lite = new DatabaseSync(db);
lite.exec("UPDATE sessions SET expires = 4102444800000; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
lite.close();
writeFileSync("../../fixtures/legacy/expected.json", JSON.stringify(expected, null, 2) + "\n");
console.log("ok");
