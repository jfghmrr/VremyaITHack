import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./app.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const headers = { origin: "http://localhost:8080", "x-perepev-request": "1" };
const input = {
  email: "singer@example.test",
  name: "Певец",
  password: "Long-demo-pass-2026",
  consent: true,
};
const send = (app, path, body, cookie) =>
  app.inject({
    method: "POST",
    url: `/api/${path}`,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload: body,
  });
const cookie = (r) => r.headers["set-cookie"].split(";")[0];
test("регистрация, вход, приватная история и выход", async () => {
  const app = createServer();
  try {
    const reg = await send(app, "register", input);
    assert.equal(reg.statusCode, 201);
    assert.match(reg.headers["set-cookie"], /HttpOnly; SameSite=Strict/);
    const c = cookie(reg);
    assert.equal((await send(app, "register", input)).statusCode, 409);
    assert.equal(
      (
        await send(app, "login", {
          ...input,
          password: "Definitely-wrong-pass",
        })
      ).statusCode,
      401,
    );
    const me = await app.inject({ url: "/api/me", headers: { cookie: c } });
    assert.equal(me.json().profile.email, input.email);
    assert.equal(me.json().profile.password, undefined);
    const attempt = {
      id: "12345678-1234-1234-1234-123456789012",
      songId: "ode",
      title: "Ода",
      score: 96,
      shift: -5,
      axes: { intervals: 1, rhythm: 1, stability: 1, coverage: 1 },
      moments: [],
      owner: me.json().profile.id,
    };
    assert.equal((await send(app, "attempts", attempt, c)).statusCode, 201);
    assert.equal((await send(app, "attempts", attempt, c)).statusCode, 201);
    const list = await app.inject({
      url: "/api/attempts",
      headers: { cookie: c },
    });
    assert.equal(list.json().attempts.length, 1);
    assert.equal(list.json().attempts[0].owner, me.json().profile.id);
    assert.equal(
      (await send(app, "attempts", { ...attempt, owner: "another-user" }, c))
        .statusCode,
      409,
    );
    const second = await send(app, "register", {
      ...input,
      email: "other@example.test",
    });
    assert.deepEqual(
      (
        await app.inject({
          url: "/api/attempts",
          headers: { cookie: cookie(second) },
        })
      ).json().attempts,
      [],
    );
    assert.equal(
      (await send(app, "attempts", { ...attempt, score: 500 }, c)).statusCode,
      400,
    );
    assert.equal((await send(app, "logout", {}, c)).statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/attempts", headers: { cookie: c } }))
        .statusCode,
      401,
    );
    const login = await send(app, "login", input);
    assert.equal(login.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          url: "/api/attempts",
          headers: { cookie: cookie(login) },
        })
      ).json().attempts.length,
      1,
    );
  } finally {
    await app.close();
  }
});
test("CSRF, слабые пароли и лимит входа", async () => {
  const app = createServer();
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/register",
          headers: { origin: "https://evil.test", "x-perepev-request": "1" },
          payload: input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await send(app, "register", { ...input, password: "short" })).statusCode,
      400,
    );
    assert.equal(
      (await send(app, "register", { ...input, consent: false })).statusCode,
      400,
    );
    for (let i = 0; i < 10; i++)
      await send(app, "login", { email: "bad", password: "short" });
    assert.equal((await send(app, "login", input)).statusCode, 429);
  } finally {
    await app.close();
  }
});
test("смена пароля отзывает старые сеансы; данные переживают перезапуск", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perepev-auth-"));
  let app = createServer({
    dbPath: join(dir, "test.sqlite"),
    secureCookies: true,
  });
  try {
    const reg = await send(app, "register", input);
    assert.match(reg.headers["set-cookie"], /Secure/);
    const old = cookie(reg);
    const updated = await send(
      app,
      "password",
      {
        currentPassword: input.password,
        newPassword: "Another-long-pass-2026",
      },
      old,
    );
    assert.equal(updated.statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/me", headers: { cookie: old } })).json()
        .profile,
      null,
    );
    await app.close();
    app = createServer({ dbPath: join(dir, "test.sqlite") });
    assert.equal((await send(app, "login", input)).statusCode, 401);
    assert.equal(
      (
        await send(app, "login", {
          ...input,
          password: "Another-long-pass-2026",
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
