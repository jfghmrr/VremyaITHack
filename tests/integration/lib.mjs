// Стенд интеграционных проверок: настоящие PostgreSQL, Valkey, два экземпляра API и
// WebSocket-клиенты, которые «поют» каноническую кривую в реальном времени.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const ORIGIN = "http://localhost:4173";
export const DB = process.env.TEST_DATABASE_URL ?? `postgres://${process.env.USER}@localhost/perepev_test`;
export const VALKEY = process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:6379/1";
// Параллельные стенды: своя база (имя из TEST_DATABASE_URL), своя база Valkey и сдвиг портов.
const DB_NAME = new URL(DB).pathname.slice(1);
const VALKEY_DB = new URL(VALKEY).pathname.slice(1) || "0";
const PORT_OFFSET = Number(process.env.TEST_PORT_OFFSET ?? 0);
const BIN = `${ROOT}target/release/perepev-api`;

export function resetStores() {
  const admin = DB.replace(new RegExp(`/${DB_NAME}$`), "/postgres");
  execFileSync("psql", [admin, "-qc", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  execFileSync("psql", [admin, "-qc", `CREATE DATABASE ${DB_NAME}`]);
  execFileSync("valkey-cli", ["-n", VALKEY_DB, "FLUSHDB"]);
}

export function sql(query) {
  return execFileSync("psql", [DB, "-Atc", query], { encoding: "utf8" }).trim();
}

export function valkey(...args) {
  return execFileSync("valkey-cli", ["-n", VALKEY_DB, ...args], { encoding: "utf8" }).trim();
}

export class Instance {
  /** `env` — дополнительные переменные окружения экземпляра (например, адреса поддельного провайдера). */
  constructor(name, port, env = {}) {
    this.name = name;
    this.port = port + PORT_OFFSET;
    this.base = `http://127.0.0.1:${this.port}`;
    this.env = env;
  }
  async start() {
    this.log = [];
    const busy = await fetch(`${this.base}/api/health`).then(() => true, () => false);
    if (busy) throw new Error(`порт ${this.port} занят другим процессом`);
    this.proc = spawn(BIN, [], {
      env: {
        ...process.env,
        BIND: `127.0.0.1:${this.port}`,
        DATABASE_URL: DB,
        VALKEY_URL: VALKEY,
        SONGS_DIR: `${ROOT}web/static/songs`,
        APP_ORIGINS: ORIGIN,
        TRUST_PROXY: "true",
        INSTANCE_ID: this.name,
        GAME_CONFIG: `${ROOT}tests/integration/game.json`,
        RUST_LOG: "warn",
        ...this.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = false;
    this.proc.on("exit", () => (exited = true));
    this.proc.stderr.on("data", (d) => this.log.push(String(d)));
    this.proc.stdout.on("data", (d) => this.log.push(String(d)));
    for (let i = 0; i < 100; i++) {
      if (exited) throw new Error(`${this.name} завершился при запуске: ${this.log.join("")}`);
      try {
        if ((await fetch(`${this.base}/api/health`)).ok) return this;
      } catch {}
      await sleep(100);
    }
    throw new Error(`${this.name} не запустился: ${this.log.join("")}`);
  }
  kill() {
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }
  stop() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }
}

// Эталоны каталога по идентификатору: сервер выбирает песню матча сам.
export const songs = new Proxy({}, {
  get: (cache, id) => (cache[id] ??= JSON.parse(readFileSync(`${ROOT}web/static/songs/${String(id)}/reference.json`, "utf8"))),
});

/** Каноническая кривая (десятые доли полутона) эталона со сдвигом и ошибками. */
export function curve(songId, shift = 0, errors = []) {
  const s = songs[songId];
  const n = Math.ceil(s.duration_s / 0.05);
  return Array.from({ length: n }, (_, i) => {
    const m = s.f0_midi[Math.min(s.f0_midi.length - 1, i * 5)];
    if (m === null) return null;
    const err = errors.find(([a, b]) => i >= a && i < b)?.[2] ?? 0;
    return Math.round((m + shift + err) * 10);
  });
}

let counter = 0;
export class Player {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.waiters = [];
    this.nextId = 1;
    this.pending = new Map();
    this.view = null;
    this.queue = null;
    this.closed = true;
  }

  async register(instance) {
    this.email = `it-${Date.now()}-${counter++}@example.test`;
    const r = await fetch(`${instance.base}/api/register`, {
      method: "POST",
      // Как за Caddy: у каждого «клиента» свой адрес, лимит входа считается по нему.
      headers: { origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/json", "x-forwarded-for": `10.0.${counter >> 8}.${counter & 255}` },
      body: JSON.stringify({ email: this.email, name: this.name, password: "Long-demo-pass-2026", consent: true, ageGroup: "14plus" }),
    });
    if (r.status !== 201) throw new Error(`register ${r.status} ${await r.text()}`);
    this.cookie = r.headers.get("set-cookie").split(";")[0];
    this.id = (await r.json()).profile.id;
    return this;
  }

  connect(instance) {
    this.instance = instance;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/api/ws`, { headers: { origin: ORIGIN, cookie: this.cookie } });
      this.ws = ws;
      ws.onopen = () => {
        this.closed = false;
        this.raw({ id: 0, type: "hello", match_id: this.view?.match_id ?? null, last_seq: this.lastSeq ?? 0 });
        for (const [id, p] of this.pending) this.raw({ id, ...p.cmd });
        this.ping = setInterval(() => this.raw({ id: 0, type: "ping", c: Date.now() }), 2000);
        resolve(this);
      };
      ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ""}`));
      ws.onclose = () => {
        this.closed = true;
        clearInterval(this.ping);
        this.notify();
      };
      ws.onmessage = (e) => this.handle(JSON.parse(e.data));
    });
  }

  disconnect() {
    clearInterval(this.ping);
    this.ws?.close();
  }

  raw(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ v: 1, ...obj }));
  }

  /** Команда с подтверждением; при разрыве ждёт и повторяется после переподключения. */
  send(cmd) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { cmd, resolve });
      this.raw({ id, ...cmd });
    });
  }

  handle(msg) {
    this.events.push(msg);
    if (msg.type === "ack") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    } else if (msg.type === "match") {
      if (msg.seq == null || !(this.view?.match_id === msg.view.match_id && msg.seq <= this.lastSeq)) {
        // Как в браузерном клиенте: состояние нового матча без номера (из базы) сбрасывает счёт,
        // иначе события только что созданной комнаты отбрасывались бы номерами прошлого матча.
        if (msg.seq == null && this.view?.match_id !== msg.view.match_id) this.lastSeq = 0;
        if (msg.seq != null) this.lastSeq = msg.seq;
        this.view = msg.view;
      }
    } else if (msg.type === "queue") this.queue = msg.state;
    else if (msg.type === "pong") this.offset = msg.s - (msg.c + (Date.now() - msg.c) / 2);
    this.notify();
  }

  notify() {
    for (const w of [...this.waiters]) if (w.test()) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve());
  }

  waitFor(test, ms = 30_000, what = "условие") {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), reject(new Error(`${this.name}: не дождались «${what}»; состояние ${JSON.stringify(this.view?.state ?? this.queue)}`)));
      }, ms);
    });
  }

  state(s, ms) {
    return this.waitFor(() => this.view?.state === s, ms, s);
  }

  /** Отправка кривой в реальном времени: точка уходит, когда её время прошло. */
  async sing(points, { stopAt = Infinity, onTick } = {}) {
    const v = this.view;
    const start = v.start_at_ms;
    let sent = 0;
    while (sent < points.length) {
      const elapsed = (Date.now() + (this.offset ?? 0) - start) / 1000;
      if (elapsed >= stopAt) return sent;
      const upto = Math.min(points.length, Math.max(0, Math.floor((elapsed - 0.06) / 0.05) + 1));
      while (sent < upto) {
        const to = Math.min(upto, sent + 20);
        void this.send({ type: "perf", match_id: v.match_id, from: sent, points: points.slice(sent, to) });
        sent = to;
      }
      onTick?.(elapsed);
      await sleep(100);
    }
    void this.send({ type: "finish", match_id: v.match_id, count: points.length });
    return sent;
  }
}

export async function songVersion(instance, id) {
  const list = await (await fetch(`${instance.base}/api/catalog`)).json();
  return list.find((s) => s.id === id).version;
}

/** Двое в рейтинговой очереди до подтверждённой готовности. */
export async function ratedMatch(a, b) {
  await a.send({ type: "queue_join" });
  await b.send({ type: "queue_join" });
  await a.waitFor(() => a.view?.state === "waiting", 15_000, "match found");
  await b.waitFor(() => b.view?.match_id === a.view.match_id, 15_000, "same match");
  const id = a.view.match_id;
  await a.send({ type: "accept", match_id: id });
  await b.send({ type: "accept", match_id: id });
  await a.state("ready_check");
  const version = await songVersion(a.instance, a.view.song.id);
  for (const p of [a, b]) await p.send({ type: "ready", match_id: id, song_version: version, algorithm_version: 1 });
  await a.waitFor(() => a.view?.start_at_ms != null, 10_000, "start");
  await b.waitFor(() => b.view?.start_at_ms != null, 10_000, "start");
  return id;
}
