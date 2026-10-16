// Кабинет по HTTP (перенос legacy/server/auth.test.mjs из тега legacy-react-fastify) и миграция SQLite → PostgreSQL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DB, Instance, ORIGIN, ROOT, resetStores, sql } from "./lib.mjs";

const api = new Instance("accounts", 3111);
let ip = 0;
const headers = (extra = {}) => ({ origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/json", "x-forwarded-for": `10.9.0.${++ip}`, ...extra });
const post = (path, body, cookie, h = {}) =>
  fetch(`${api.base}/api/${path}`, { method: "POST", headers: headers({ ...(cookie ? { cookie } : {}), ...h }), body: JSON.stringify(body) });
const get = (path, cookie) => fetch(`${api.base}/api/${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (r) => r.headers.get("set-cookie").split(";")[0];
const input = { email: "singer@example.test", name: "Певец", password: "Long-demo-pass-2026", consent: true, ageGroup: "14plus" };

before(async () => {
  resetStores();
  await api.start();
});
after(() => api.stop());

describe("кабинет", { concurrency: false }, () => {
  it("регистрация, вход, приватная история и выход", async () => {
    const reg = await post("register", input);
    assert.equal(reg.status, 201);
    assert.match(reg.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const c = cookieOf(reg);
    assert.equal((await post("register", input)).status, 409);
    assert.equal((await post("login", { ...input, password: "Definitely-wrong-pass" })).status, 401);
    const me = await (await get("me", c)).json();
    assert.equal(me.profile.email, input.email);
    assert.equal(me.profile.password, undefined);
    assert.equal(me.rating.calibrating, true);
    const attempt = {
      id: "12345678-1234-1234-1234-123456789012", songId: "ode", title: "Ода", score: 96, shift: -5,
      axes: { intervals: 1, rhythm: 1, stability: 1, coverage: 1 }, moments: [], owner: me.profile.id, algorithmVersion: 1,
    };
    assert.equal((await post("attempts", attempt, c)).status, 201);
    assert.equal((await post("attempts", attempt, c)).status, 201, "повтор идемпотентен");
    const list = await (await get("attempts", c)).json();
    assert.equal(list.attempts.length, 1);
    assert.equal(list.attempts[0].owner, me.profile.id);
    assert.equal(list.attempts[0].algorithmVersion, 1);
    assert.equal((await post("attempts", { ...attempt, owner: "another-user" }, c)).status, 409);
    const second = await post("register", { ...input, email: "other@example.test" });
    assert.deepEqual((await (await get("attempts", cookieOf(second))).json()).attempts, []);
    assert.equal((await post("attempts", { ...attempt, score: 500 }, c)).status, 400);
    assert.equal((await post("logout", {}, c)).status, 200);
    assert.equal((await get("attempts", c)).status, 401);
    const login = await post("login", { ...input, email: "SINGER@example.test" });
    assert.equal(login.status, 200);
    assert.equal((await (await get("attempts", cookieOf(login))).json()).attempts.length, 1);
  });

  it("точная попытка хранит тег алгоритма и признак проверки слов (спецификация §5.6)", async () => {
    const reg = await post("register", { ...input, email: "precise@example.test" });
    const c = cookieOf(reg);
    const owner = (await reg.json()).profile.id;
    const base = { songId: "cn-earth", title: "Земное притяжение", score: 88, shift: 0,
      axes: { intervals: 0.9, rhythm: 0.8, stability: 0.9, coverage: 0.95 }, moments: [], owner, algorithmVersion: 1 };
    const ids = ["32345678-1234-1234-1234-123456789012", "42345678-1234-1234-1234-123456789012", "52345678-1234-1234-1234-123456789012"];
    assert.equal((await post("attempts", { ...base, id: ids[0], algorithm: "precise-1", wordsChecked: true }, c)).status, 201);
    assert.equal((await post("attempts", { ...base, id: ids[1], algorithm: "precise-1", wordsChecked: false }, c)).status, 201);
    assert.equal((await post("attempts", { ...base, id: ids[2], wordsChecked: false }, c)).status, 201, "браузерный балл");
    for (const bad of [{ algorithm: "precise-9" }, { algorithm: "" }, { wordsChecked: true }])
      assert.equal((await post("attempts", { ...base, id: "62345678-1234-1234-1234-123456789012", ...bad }, c)).status, 400, JSON.stringify(bad));
    const byId = Object.fromEntries((await (await get("attempts", c)).json()).attempts.map((a) => [a.id, a]));
    assert.deepEqual([ids[0], ids[1], ids[2]].map((id) => [byId[id].algorithm, byId[id].wordsChecked]), [["precise-1", true], ["precise-1", false], [null, false]]);
    assert.equal(sql(`SELECT algorithm || ' ' || words_checked FROM attempts WHERE id = '${ids[0]}'`), "precise-1 true");
    const exported = await (await get("me/export", c)).json();
    const row = exported.attempts.find((a) => a.id === ids[0]);
    assert.equal(row.algorithm, "precise-1");
    assert.equal(row.words_checked, true);
    // Попытка прежнего клиента без новых полей: оба поля NULL.
    const old = { ...base, id: "72345678-1234-1234-1234-123456789012" };
    assert.equal((await post("attempts", old, c)).status, 201);
    assert.equal(sql(`SELECT (algorithm IS NULL) || ' ' || (words_checked IS NULL) FROM attempts WHERE id = '${old.id}'`), "true true");
  });

  it("CSRF, слабые пароли и лимит входа", async () => {
    assert.equal((await post("register", input, null, { origin: "https://evil.test" })).status, 403);
    assert.equal((await post("register", input, null, { "x-perepev-request": "0" })).status, 403);
    assert.equal(
      (await fetch(`${api.base}/api/register`, { method: "POST", headers: { origin: ORIGIN, "x-perepev-request": "1", "content-type": "text/plain" }, body: "{}" })).status,
      415,
    );
    assert.equal((await post("register", { ...input, password: "short" })).status, 400);
    assert.equal((await post("register", { ...input, consent: false })).status, 400);
    const fixed = { "x-forwarded-for": "10.99.99.99" };
    for (let i = 0; i < 12; i++) await post("login", { email: "bad", password: "short" }, null, fixed);
    const limited = await post("login", input, null, fixed);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  it("смена пароля отзывает старые сеансы; данные переживают перезапуск", async () => {
    const reg = await post("register", { ...input, email: "change@example.test" });
    const old = cookieOf(reg);
    const updated = await post("password", { currentPassword: input.password, newPassword: "Another-long-pass-2026" }, old);
    assert.equal(updated.status, 200);
    assert.equal((await (await get("me", old)).json()).profile, null);
    api.stop();
    await api.start();
    assert.equal((await post("login", { ...input, email: "change@example.test" })).status, 401);
    assert.equal((await post("login", { ...input, email: "change@example.test", password: "Another-long-pass-2026" })).status, 200);
  });
});

describe("152-ФЗ: согласие, выгрузка, удаление", () => {
  it("согласие фиксируется, данные выгружаются, кабинет удаляется полностью", async () => {
    const email = "erase@example.test";
    const reg = await post("register", { ...input, email });
    const c = cookieOf(reg);
    const id = (await reg.json()).profile.id;
    assert.match(sql(`SELECT consent_version || ' ' || (consent_at IS NOT NULL) FROM users WHERE id = '${id}'`), /^2026-10-17 (t|true)$/);
    await post("attempts", { id: "22345678-1234-1234-1234-123456789012", songId: "ode", title: "Ода", score: 80, shift: 1,
      axes: { intervals: 1, rhythm: 1, stability: 1, coverage: 1 }, moments: [], owner: id }, c);
    const exp = await get("me/export", c);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-disposition"), /attachment/);
    const data = await exp.json();
    assert.equal(data.profile.email, email);
    assert.equal(data.attempts.length, 1);
    assert.equal(data.consent.version, "2026-10-17");
    assert.equal((await get("me/export")).status, 401);
    assert.equal((await post("me/delete", { password: "Wrong-password-123" }, c)).status, 401);
    const del = await post("me/delete", { password: input.password }, c);
    assert.equal(del.status, 200);
    assert.match(del.headers.get("set-cookie"), /Max-Age=0/);
    for (const table of ["users WHERE id", "sessions WHERE user_id", "attempts WHERE user_id", "ratings WHERE user_id"])
      assert.equal(sql(`SELECT count(*) FROM ${table} = '${id}'`), "0", table);
    assert.equal((await (await get("me", c)).json()).profile, null);
    assert.equal((await post("login", { ...input, email })).status, 401);
  });
});

describe("миграция SQLite → PostgreSQL", () => {
  it("старые хеши, сессии и история переносятся; повторный импорт ничего не дублирует", async () => {
    // Настоящая база прежней версии, созданная её сервером (tools/fixtures/make-legacy-db.mjs).
    const dir = mkdtempSync(join(tmpdir(), "perepev-legacy-"));
    const db = join(dir, "perepev.sqlite");
    copyFileSync(`${ROOT}fixtures/legacy/perepev.sqlite`, db);
    const expected = JSON.parse(readFileSync(`${ROOT}fixtures/legacy/expected.json`, "utf8"));
    try {
      const bin = `${ROOT}target/release/perepev-api`;
      const env = { ...process.env, DATABASE_URL: DB };
      const dry = execFileSync(bin, ["import-legacy", db, "--dry-run"], { env, encoding: "utf8" });
      assert.match(dry, /Пробный запуск/);
      assert.equal(sql("SELECT count(*) FROM users WHERE imported_from_legacy"), "0");
      const out = execFileSync(bin, ["import-legacy", db], { env, encoding: "utf8" });
      assert.match(out, /2 пользователей, 2 действующих сессий, 3 попыток/);
      execFileSync(bin, ["import-legacy", db], { env, encoding: "utf8" });
      assert.equal(sql("SELECT count(*) FROM users WHERE imported_from_legacy"), "2");
      for (const u of expected.users) {
        // Вход старым паролем без повторной регистрации, включая пароль с юникодом.
        assert.equal((await post("login", { email: u.email, password: u.password })).status, 200, u.email);
        // Старая сессия продолжает работать после переключения.
        const me = await (await get("me", u.cookie)).json();
        assert.equal(me.profile.name, u.name);
        const hist = await (await get("attempts", u.cookie)).json();
        assert.deepEqual(hist.attempts.map((a) => a.score).sort(), [...u.scores].sort());
        assert.ok(hist.attempts.every((a) => a.algorithmVersion === null), "старые баллы помечены как посчитанные прежней версией");
      }
      // Исходный файл не меняется: это путь отката.
      assert.deepEqual(readFileSync(db), readFileSync(`${ROOT}fixtures/legacy/perepev.sqlite`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
