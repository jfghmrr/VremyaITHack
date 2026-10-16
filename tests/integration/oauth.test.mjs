// Вход через Яндекс ID и VK ID против поддельного провайдера на Node, возрастная группа
// при регистрации, подтверждение словом «УДАЛИТЬ» без пароля и жалобы правообладателей.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { Instance, ORIGIN, resetStores, sql } from "./lib.mjs";

// Поддельный провайдер: отвечает как Яндекс и VK ID и запоминает каждый запрос.
const seen = [];
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock");
  let body = "";
  for await (const chunk of req) body += chunk;
  const form = Object.fromEntries(new URLSearchParams(body));
  seen.push({ method: req.method, path: url.pathname, form, authorization: req.headers.authorization, type: req.headers["content-type"] });
  const reply = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "POST" && url.pathname === "/yandex/token") {
    if (form.code === "bad-code") return reply(400, { error: "invalid_grant" });
    return reply(200, { access_token: `ya-token-${form.code}`, token_type: "bearer", expires_in: 3600 });
  }
  if (req.method === "GET" && url.pathname === "/yandex/info") {
    const m = /^OAuth ya-token-(.+)$/.exec(req.headers.authorization ?? "");
    if (!m || url.searchParams.get("format") !== "json") return reply(401, { error: "unauthorized" });
    return reply(200, { id: `id-${m[1]}`, login: "singer" });
  }
  if (req.method === "POST" && url.pathname === "/vk/oauth2/auth") {
    return reply(200, {
      access_token: "vk-token", refresh_token: "vk-refresh", id_token: "vk-id", token_type: "Bearer",
      expires_in: 3600, user_id: 4242, state: form.state, scope: "vkid.personal_info",
    });
  }
  reply(404, { error: "not found" });
});
const calls = (path) => seen.filter((c) => c.path === path);

// Без настроек: пустые значения равны отсутствующим, даже если они есть в окружении разработчика.
const off = new Instance("oauth-off", 3141, {
  YANDEX_CLIENT_ID: "", YANDEX_CLIENT_SECRET: "", VK_CLIENT_ID: "", VK_CLIENT_SECRET: "",
});
let api;
let mockBase;

before(async () => {
  resetStores();
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  api = new Instance("oauth", 3142, {
    YANDEX_CLIENT_ID: "yandex-client",
    YANDEX_CLIENT_SECRET: "yandex-secret",
    VK_CLIENT_ID: "vk-client",
    VK_CLIENT_SECRET: "vk-secret",
    PUBLIC_ORIGIN: ORIGIN,
    OAUTH_YANDEX_BASE: `${mockBase}/yandex`,
    OAUTH_YANDEX_INFO: `${mockBase}/yandex/info`,
    OAUTH_VK_BASE: `${mockBase}/vk`,
  });
  await off.start();
  await api.start();
});
after(() => {
  off.stop();
  api?.stop();
  mock.close();
});

let ip = 0;
const headers = (extra = {}) => ({ origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/json", "x-forwarded-for": `10.8.${ip >> 8}.${++ip & 255}`, ...extra });
const post = (path, body, cookie, h = {}) =>
  fetch(`${api.base}/api/${path}`, { method: "POST", headers: headers({ ...(cookie ? { cookie } : {}), ...h }), body: JSON.stringify(body) });
const get = (path, cookie) => fetch(`${api.base}/api/${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
const cookieNamed = (r, name) => r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`));
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");

/** Начало входа: адрес провайдера с параметрами и временная cookie браузера. */
async function start(provider, ret = "/songs") {
  const r = await get(`auth/${provider}/start?return=${encodeURIComponent(ret)}`);
  assert.equal(r.status, 302, `start ${provider}`);
  const location = new URL(r.headers.get("location"));
  return { r, location, params: location.searchParams, state: location.searchParams.get("state"), cookie: cookieNamed(r, "perepev_oauth") };
}
const callback = (provider, query, cookie) => get(`auth/${provider}/callback?${new URLSearchParams(query)}`, cookie);
const signupToken = (r) => new URL(r.headers.get("location"), ORIGIN).searchParams.get("signup");

/** Новый пользователь провайдера до готовой сессии. */
async function newProviderUser(provider, code, extra = {}) {
  const s = await start(provider);
  const r = await callback(provider, { code, state: s.state, ...extra }, s.cookie);
  const done = await post("auth/complete", { token: signupToken(r), consent: true, ageGroup: "14plus", parentName: null }, cookieNamed(r, "perepev_oauth"));
  assert.equal(done.status, 201);
  return { cookie: cookieNamed(done, "perepev_session"), profile: (await done.json()).profile };
}

describe("вход через Яндекс ID и VK ID", { concurrency: false }, () => {
  let aliceId;

  it("без настроек провайдеры скрыты, с настройками — оба", async () => {
    assert.deepEqual(await (await fetch(`${off.base}/api/auth/providers`)).json(), { providers: [] });
    const r = await fetch(`${off.base}/api/auth/yandex/start?return=/songs`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/account?authError=provider");
    assert.deepEqual(await (await get("auth/providers")).json(), { providers: ["yandex", "vk"] });
    assert.equal((await get("auth/google/start")).headers.get("location"), "/account?authError=provider");
  });

  it("начало входа: PKCE S256 и state не короче 43 символов", async () => {
    const { r, location, params, state } = await start("yandex");
    assert.equal(`${location.origin}${location.pathname}`, `${mockBase}/yandex/authorize`);
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("client_id"), "yandex-client");
    assert.equal(params.get("redirect_uri"), `${ORIGIN}/api/auth/yandex/callback`);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.match(params.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(params.get("scope"), "login:info");
    assert.equal(params.has("client_secret"), false, "секрет не уходит в браузер");
    assert.ok(state.length >= 43, state);
    assert.match(r.headers.get("set-cookie"), /^perepev_oauth=[0-9a-f]+; Path=\/api\/auth\/; HttpOnly; SameSite=Lax; Max-Age=600/);
    const vk = await start("vk");
    assert.equal(`${vk.location.origin}${vk.location.pathname}`, `${mockBase}/vk/authorize`);
    assert.equal(vk.params.get("scope"), "vkid.personal_info");
    assert.equal(vk.params.get("code_challenge_method"), "S256");
    assert.equal(vk.params.get("redirect_uri"), `${ORIGIN}/api/auth/vk/callback`);
    assert.notEqual(vk.state, state);
  });

  it("неизвестный, чужой и повторный state, отказ пользователя: без сессии", async () => {
    const before = calls("/yandex/token").length;
    const unknown = await callback("yandex", { code: "x", state: "f".repeat(64) });
    assert.equal(unknown.status, 302);
    assert.equal(unknown.headers.get("location"), "/account?authError=state");
    assert.equal(cookieNamed(unknown, "perepev_session"), undefined);
    // state настоящий, но cookie от другого входа: ссылку подсунули чужому браузеру.
    const a = await start("yandex");
    const b = await start("yandex");
    const mixed = await callback("yandex", { code: "x", state: a.state }, b.cookie);
    assert.equal(mixed.headers.get("location"), "/account?authError=state");
    assert.equal(cookieNamed(mixed, "perepev_session"), undefined);
    // Пользователь отменил вход у провайдера.
    const denied = await callback("yandex", { error: "access_denied", state: b.state }, b.cookie);
    assert.equal(denied.headers.get("location"), "/account?authError=denied");
    assert.equal(cookieNamed(denied, "perepev_session"), undefined);
    // После отказа state израсходован.
    const reused = await callback("yandex", { code: "x", state: b.state }, b.cookie);
    assert.equal(reused.headers.get("location"), "/account?authError=state");
    assert.equal(cookieNamed(reused, "perepev_session"), undefined);
    assert.equal(calls("/yandex/token").length, before, "без верного state провайдер не вызывается");
  });

  it("новый пользователь Яндекса: согласие и возраст, затем сессия; повтор ответа не проходит", async () => {
    const s = await start("yandex", "/songs");
    const r = await callback("yandex", { code: "alice", state: s.state }, s.cookie);
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/account\?signup=[0-9a-f]{64}$/);
    assert.equal(cookieNamed(r, "perepev_session"), undefined);
    // Токен регистрации привязан к этому браузеру той же временной cookie.
    const token = signupToken(r);
    const bound = cookieNamed(r, "perepev_oauth");
    assert.equal(bound, `perepev_oauth=${token}`);
    const exchange = calls("/yandex/token").at(-1);
    assert.equal(exchange.type, "application/x-www-form-urlencoded");
    assert.equal(exchange.form.grant_type, "authorization_code");
    assert.equal(exchange.form.code, "alice");
    assert.equal(exchange.form.client_id, "yandex-client");
    assert.equal(exchange.form.client_secret, "yandex-secret");
    assert.equal(challengeOf(exchange.form.code_verifier), s.params.get("code_challenge"), "PKCE verifier соответствует challenge");
    assert.equal(calls("/yandex/info").at(-1).authorization, "OAuth ya-token-alice");

    assert.equal((await post("auth/complete", { token, consent: false, ageGroup: "14plus", parentName: null }, bound)).status, 400);
    assert.equal((await post("auth/complete", { token, consent: true }, bound)).status, 400, "возраст обязателен");
    assert.equal((await post("auth/complete", { token, consent: true, ageGroup: "under14", parentName: null }, bound)).status, 400, "до 14 лет нужно имя родителя");
    assert.equal((await post("auth/complete", { token, consent: true, ageGroup: "14plus", parentName: null })).status, 400, "без cookie этого браузера");
    const done = await post("auth/complete", { token, consent: true, ageGroup: "14plus", parentName: null }, bound);
    assert.equal(done.status, 201);
    assert.match(done.headers.get("set-cookie"), /perepev_oauth=; Path=\/api\/auth\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.match(done.headers.get("set-cookie"), /^perepev_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
    const session = cookieNamed(done, "perepev_session");
    const { profile } = await done.json();
    assert.match(profile.name, /^Певец-\d{4}$/);
    assert.equal(profile.email, null);
    assert.equal(profile.hasPassword, false);
    assert.deepEqual(profile.providers, ["yandex"]);
    const me = await (await get("me", session)).json();
    assert.deepEqual(me.profile, profile);
    assert.equal(sql(`SELECT consent_version || ' ' || age_group || ' ' || (consent_at IS NOT NULL) FROM users WHERE id = '${profile.id}'`), "2026-10-17 14plus true");
    assert.equal(sql(`SELECT provider || ':' || subject FROM identities WHERE user_id = '${profile.id}'`), "yandex:id-alice");
    assert.equal((await post("auth/complete", { token, consent: true, ageGroup: "14plus" }, bound)).status, 400, "токен одноразовый");
    const replay = await callback("yandex", { code: "alice", state: s.state }, s.cookie);
    assert.equal(replay.headers.get("location"), "/account?authError=state");
    assert.equal(cookieNamed(replay, "perepev_session"), undefined, "повтор ответа провайдера не даёт сессию");
    aliceId = profile.id;
  });

  it("повторный вход той же учётной записью ведёт на страницу возврата с сессией", async () => {
    const s = await start("yandex", "/songs?lang=ru");
    const r = await callback("yandex", { code: "alice", state: s.state }, s.cookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/songs?lang=ru");
    assert.match(r.headers.get("set-cookie"), /perepev_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
    const me = await (await get("me", cookieNamed(r, "perepev_session"))).json();
    assert.equal(me.profile.id, aliceId);
    assert.equal(sql("SELECT count(*) FROM identities WHERE provider = 'yandex' AND subject = 'id-alice'"), "1");
    // Возврат только на свой сайт: чужие и подозрительные адреса заменяются на /account.
    for (const evil of ["//evil.test/x", "https://evil.test/", "/\\evil.test", "javascript:alert(1)", "/\t/evil.test", "/api/logout", "songs"]) {
      const e = await start("yandex", evil);
      const back = await callback("yandex", { code: "alice", state: e.state }, e.cookie);
      assert.equal(back.headers.get("location"), "/account", JSON.stringify(evil));
    }
  });

  it("VK ID: обмен кода отправляет device_id и code_verifier; до 14 лет с именем родителя", async () => {
    const s = await start("vk", "/");
    const r = await callback("vk", { code: "vk-code", state: s.state, device_id: "device-123", type: "code_v2" }, s.cookie);
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/account\?signup=[0-9a-f]{64}$/);
    const ex = calls("/vk/oauth2/auth").at(-1);
    assert.equal(ex.type, "application/x-www-form-urlencoded");
    const { code_verifier, ...rest } = ex.form;
    assert.deepEqual(rest, {
      grant_type: "authorization_code",
      code: "vk-code",
      client_id: "vk-client",
      device_id: "device-123",
      redirect_uri: `${ORIGIN}/api/auth/vk/callback`,
      state: s.state,
    });
    assert.equal(challengeOf(code_verifier), s.params.get("code_challenge"));
    const done = await post("auth/complete", { token: signupToken(r), consent: true, ageGroup: "under14", parentName: "Мария Иванова" }, cookieNamed(r, "perepev_oauth"));
    assert.equal(done.status, 201);
    const { profile } = await done.json();
    assert.deepEqual(profile.providers, ["vk"]);
    assert.equal(
      sql(`SELECT i.subject || ' ' || u.age_group || ' ' || u.parent_name FROM identities i JOIN users u ON u.id = i.user_id WHERE u.id = '${profile.id}'`),
      "4242 under14 Мария Иванова",
    );
    // Без device_id обмен невозможен.
    const s2 = await start("vk");
    const noDevice = await callback("vk", { code: "vk-code", state: s2.state }, s2.cookie);
    assert.equal(noDevice.headers.get("location"), "/account?authError=provider");
  });

  it("ошибка обмена кода у провайдера", async () => {
    const s = await start("yandex");
    const r = await callback("yandex", { code: "bad-code", state: s.state }, s.cookie);
    assert.equal(r.headers.get("location"), "/account?authError=provider");
    assert.equal(cookieNamed(r, "perepev_session"), undefined);
    // Сбой записан в журнал без кодов, токенов, секретов и state.
    const log = api.log.join("");
    assert.match(log, /oauth: code exchange failed/);
    for (const secret of ["yandex-secret", "vk-secret", "bad-code", "ya-token", "vk-token", s.state]) assert.equal(log.includes(secret), false, secret);
  });
});

describe("регистрация с возрастом и кабинет без пароля", { concurrency: false }, () => {
  const input = { email: "age@example.test", name: "Певец", password: "Long-demo-pass-2026", consent: true };

  it("возрастная группа обязательна, до 14 лет — имя родителя от 2 до 64 символов", async () => {
    assert.equal((await post("register", input)).status, 400);
    assert.equal((await post("register", { ...input, ageGroup: "adult" })).status, 400);
    assert.equal((await post("register", { ...input, ageGroup: "under14" })).status, 400);
    assert.equal((await post("register", { ...input, ageGroup: "under14", parentName: "М" })).status, 400);
    assert.equal((await post("register", { ...input, ageGroup: "under14", parentName: "М".repeat(65) })).status, 400);
    const ok = await post("register", { ...input, ageGroup: "under14", parentName: " Мария Иванова " });
    assert.equal(ok.status, 201);
    const { profile } = await ok.json();
    assert.equal(profile.email, input.email);
    assert.equal(profile.hasPassword, true);
    assert.deepEqual(profile.providers, []);
    assert.equal(sql(`SELECT age_group || ' ' || parent_name || ' ' || consent_version FROM users WHERE id = '${profile.id}'`), "under14 Мария Иванова 2026-10-17");
    const exported = await (await get("me/export", cookieNamed(ok, "perepev_session"))).json();
    assert.deepEqual(exported.age, { group: "under14", parent_name: "Мария Иванова" });
    assert.deepEqual(exported.identities, []);
    const adult = await post("register", { ...input, email: "adult@example.test", ageGroup: "14plus", parentName: "Лишнее" });
    assert.equal(adult.status, 201);
    assert.equal(sql("SELECT age_group || ' ' || coalesce(parent_name, '-') FROM users WHERE email = 'adult@example.test'"), "14plus -");
  });

  it("без пароля удаление подтверждается словом «УДАЛИТЬ»", async () => {
    const { cookie, profile } = await newProviderUser("yandex", "bob");
    const exported = await (await get("me/export", cookie)).json();
    assert.equal(exported.identities[0].provider, "yandex");
    assert.equal((await post("me/delete", { password: "Long-demo-pass-2026" }, cookie)).status, 400);
    assert.equal((await post("me/delete", { confirm: "удали" }, cookie)).status, 400);
    const del = await post("me/delete", { confirm: "УДАЛИТЬ" }, cookie);
    assert.equal(del.status, 200);
    assert.match(del.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(sql(`SELECT count(*) FROM users WHERE id = '${profile.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM identities WHERE user_id = '${profile.id}'`), "0");
    assert.equal((await (await get("me", cookie)).json()).profile, null);
  });

  it("без почты пароль не задаётся: войти по нему нельзя, а удаление осталось бы без пароля", async () => {
    const { cookie, profile } = await newProviderUser("yandex", "carol");
    assert.equal(profile.email, null);
    for (const body of [{ newPassword: "Another-long-pass-2026" }, { confirm: "УДАЛИТЬ", newPassword: "Another-long-pass-2026" }]) {
      const r = await post("password", body, cookie);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /почт/);
    }
    assert.equal(sql(`SELECT count(*) FROM users WHERE id = '${profile.id}' AND password_hash IS NULL`), "1");
    assert.equal((await (await get("me", cookie)).json()).profile.hasPassword, false, "сессия жива, пароль не появился");
    assert.equal((await post("me/delete", { confirm: "УДАЛИТЬ" }, cookie)).status, 200, "удаление словом по-прежнему работает");
  });
});

describe("жалобы правообладателей", () => {
  it("проверка полей, сохранение и не больше 5 в час с адреса", async () => {
    const fixed = { "x-forwarded-for": "10.77.0.1" };
    const ok = { name: "Правообладатель", email: "rights@example.test", url: "https://perepev.lumnex.ru/songs", text: "Прошу удалить загруженный трек." };
    for (const bad of [
      { ...ok, email: "bad" },
      { ...ok, name: " " },
      { ...ok, text: "" },
      { ...ok, text: "я".repeat(2001) },
      { ...ok, url: "x".repeat(2001) },
    ])
      assert.equal((await post("complaints", bad, null, fixed)).status, 400, JSON.stringify(bad).slice(0, 80));
    for (let i = 0; i < 5; i++) {
      const r = await post("complaints", { ...ok, text: `${ok.text} ${i}` }, null, fixed);
      assert.equal(r.status, 201);
      assert.match((await r.json()).id, /^[0-9a-f-]{36}$/);
    }
    const sixth = await post("complaints", ok, null, fixed);
    assert.equal(sixth.status, 429);
    assert.ok(Number(sixth.headers.get("retry-after")) > 3000);
    assert.equal(sql("SELECT count(*) FROM complaints"), "5");
    assert.equal(sql("SELECT name || ' ' || email FROM complaints LIMIT 1"), "Правообладатель rights@example.test");
    assert.equal((await post("complaints", { ...ok, url: "" }, null, { "x-forwarded-for": "10.77.0.2" })).status, 201, "ссылка необязательна");
  });
});
