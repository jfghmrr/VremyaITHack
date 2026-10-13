import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const passwordKey = (value, salt) =>
  derive(value, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const str = (v, min, max) =>
  typeof v === "string" && v.length >= min && v.length <= max;
export function createServer({
  dbPath = ":memory:",
  origins = [
    "http://localhost:8080",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ],
  secureCookies = false,
  now = Date.now,
} = {}) {
  const app = Fastify({ bodyLimit: 16384, logger: false });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT NOT NULL,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE INDEX IF NOT EXISTS attempt_owner ON attempts(user_id,at);
 `);
  const limits = new Map();
  let hashing = 0;
  const token = (req) =>
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("perepev_session="))
      ?.slice(16) || "";
  const profile = (row) => ({ id: row.id, email: row.email, name: row.name });
  function user(req) {
    const t = token(req);
    if (!/^[a-f0-9]{64}$/.test(t)) return null;
    return (
      db
        .prepare(
          "SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE hash=? AND expires>?",
        )
        .get(digest(t), now()) || null
    );
  }
  function required(req) {
    const u = user(req);
    if (!u) throw fail("Войди в кабинет, чтобы продолжить.", 401);
    return u;
  }
  function cookie(reply, value, seconds = 604800) {
    reply.header(
      "Set-Cookie",
      `perepev_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookies ? "; Secure" : ""}`,
    );
  }
  function session(req, reply, id) {
    db.prepare("DELETE FROM sessions WHERE expires<=? OR hash=?").run(
      now(),
      digest(token(req)),
    );
    const t = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      digest(t),
      id,
      now() + 604800000,
    );
    cookie(reply, t);
  }
  async function hash(value, salt) {
    if (hashing >= 2)
      throw fail("Сервер занят. Попробуй через несколько секунд.", 503);
    hashing++;
    try {
      return await passwordKey(value, salt);
    } finally {
      hashing--;
    }
  }
  function credentials(body, registration = false) {
    if (
      !body ||
      !str(body.email, 3, 254) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      !str(body.password, 12, 128)
    )
      throw fail("Введи корректную почту и пароль от 12 до 128 символов.");
    if (
      registration &&
      (typeof body.name !== "string" ||
        !str(body.name.trim(), 2, 32) ||
        body.consent !== true)
    )
      throw fail(
        "Укажи имя от 2 до 32 символов и согласись сохранить данные кабинета.",
      );
    return {
      ...body,
      email: body.email.trim().toLowerCase(),
      name: typeof body.name === "string" ? body.name.trim() : undefined,
    };
  }
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      if (
        !origins.includes(req.headers.origin) ||
        req.headers["x-perepev-request"] !== "1"
      )
        throw fail("Запрос с другого сайта отклонён. Обнови страницу.", 403);
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw fail("Ожидается JSON.", 415);
    }
    if (
      ["/api/register", "/api/login", "/api/password"].includes(
        req.url.split("?")[0],
      )
    ) {
      const time = now();
      for (const [k, v] of limits) if (v.until <= time) limits.delete(k);
      if (limits.size > 10000) throw fail("Сервер занят. Попробуй позже.", 503);
      const entry = limits.get(req.ip) || { count: 0, until: time + 900000 };
      entry.count++;
      limits.set(req.ip, entry);
      if (entry.count > 12) {
        reply.header("Retry-After", Math.ceil((entry.until - time) / 1000));
        throw fail("Слишком много попыток. Попробуй через 15 минут.", 429);
      }
    }
  });
  app.setErrorHandler((err, req, reply) => {
    const code = err.statusCode || 500;
    reply.code(code).send({
      error:
        code >= 500
          ? "Сервис временно недоступен. Попробуй позже."
          : err.message,
    });
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/me", async (req) => {
    const u = user(req);
    return { profile: u ? profile(u) : null };
  });
  app.post("/api/register", async (req, reply) => {
    const b = credentials(req.body, true),
      salt = randomBytes(16).toString("hex"),
      key = await hash(b.password, salt),
      id = randomUUID();
    try {
      db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run(
        id,
        b.email,
        b.name,
        salt,
        key.toString("hex"),
      );
    } catch (err) {
      if (
        err.code?.includes("SQLITE_CONSTRAINT") ||
        err.errcode === 2067 ||
        err.errcode === 1555
      )
        throw fail(
          "Не удалось создать кабинет с этой почтой. Попробуй войти.",
          409,
        );
      throw err;
    }
    session(req, reply, id);
    return reply
      .code(201)
      .send({ profile: { id, email: b.email, name: b.name } });
  });
  app.post("/api/login", async (req, reply) => {
    const b = credentials(req.body),
      u = db.prepare("SELECT * FROM users WHERE email=?").get(b.email);
    const key = await hash(
      b.password,
      u?.salt || "00000000000000000000000000000000",
    );
    if (!u || !timingSafeEqual(key, Buffer.from(u.password, "hex")))
      throw fail("Неверная почта или пароль.", 401);
    session(req, reply, u.id);
    return { profile: profile(u) };
  });
  app.post("/api/logout", async (req, reply) => {
    db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(token(req)));
    cookie(reply, "", 0);
    return { ok: true };
  });
  app.patch("/api/me", async (req) => {
    const u = required(req),
      name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!str(name, 2, 32))
      throw fail("Имя должно содержать от 2 до 32 символов.");
    db.prepare("UPDATE users SET name=? WHERE id=?").run(name, u.id);
    return { profile: { ...profile(u), name } };
  });
  app.post("/api/password", async (req, reply) => {
    const u = required(req),
      b = req.body;
    if (!str(b?.currentPassword, 12, 128) || !str(b?.newPassword, 12, 128))
      throw fail("Пароль должен содержать от 12 до 128 символов.");
    if (
      !timingSafeEqual(
        await hash(b.currentPassword, u.salt),
        Buffer.from(u.password, "hex"),
      )
    )
      throw fail("Текущий пароль неверен.", 401);
    const salt = randomBytes(16).toString("hex"),
      key = await hash(b.newPassword, salt);
    db.prepare("UPDATE users SET salt=?,password=? WHERE id=?").run(
      salt,
      key.toString("hex"),
      u.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
    session(req, reply, u.id);
    return { ok: true };
  });
  app.get("/api/attempts", async (req) => {
    const u = required(req);
    return {
      attempts: db
        .prepare(
          "SELECT id,at,payload FROM attempts WHERE user_id=? ORDER BY at DESC LIMIT 100",
        )
        .all(u.id)
        .map((r) => ({
          ...JSON.parse(r.payload),
          id: r.id,
          at: r.at,
          owner: u.id,
        })),
    };
  });
  app.post("/api/attempts", async (req, reply) => {
    const u = required(req),
      b = req.body;
    if (
      !b ||
      !str(b.id, 36, 36) ||
      !str(b.songId, 1, 80) ||
      !str(b.title, 1, 200) ||
      !Number.isFinite(b.score) ||
      b.score < 0 ||
      b.score > 100 ||
      !Number.isFinite(b.shift) ||
      Math.abs(b.shift) > 127 ||
      !b.axes ||
      !["intervals", "rhythm", "stability", "coverage"].every(
        (k) => Number.isFinite(b.axes[k]) && b.axes[k] >= 0 && b.axes[k] <= 1,
      ) ||
      !Array.isArray(b.moments) ||
      b.moments.length > 3 ||
      !b.moments.every(
        (m) =>
          m &&
          str(m.text, 1, 1000) &&
          Number.isFinite(m.start_s) &&
          Number.isFinite(m.end_s) &&
          m.start_s >= 0 &&
          m.end_s >= m.start_s &&
          m.end_s <= 60 &&
          Number.isInteger(m.phrase) &&
          ["pitch", "rhythm", "missing"].includes(m.reason),
      )
    )
      throw fail("Некорректный результат.");
    if (b.owner && b.owner !== u.id)
      throw fail(
        "Аккаунт изменился в другой вкладке. Обнови страницу перед новой попыткой.",
        409,
      );
    const payload = {
      songId: b.songId,
      title: b.title,
      name: u.name,
      score: b.score,
      shift: b.shift,
      axes: Object.fromEntries(
        ["intervals", "rhythm", "stability", "coverage"].map((k) => [
          k,
          b.axes[k],
        ]),
      ),
      moments: b.moments.map((m) => ({
        text: m.text,
        start_s: m.start_s,
        end_s: m.end_s,
        phrase: m.phrase,
        reason: m.reason,
        loss: Number.isFinite(m.loss) ? m.loss : 0,
      })),
    };
    db.prepare("INSERT OR IGNORE INTO attempts VALUES(?,?,?,?)").run(
      b.id,
      u.id,
      new Date(now()).toISOString(),
      JSON.stringify(payload),
    );
    db.prepare(
      "DELETE FROM attempts WHERE user_id=? AND id NOT IN (SELECT id FROM attempts WHERE user_id=? ORDER BY at DESC LIMIT 100)",
    ).run(u.id, u.id);
    return reply.code(201).send({ ok: true });
  });
  app.addHook("onClose", async () => db.close());
  return app;
}
