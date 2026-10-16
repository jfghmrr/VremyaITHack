// Очередь задач GPU-обработчика: точная оценка исполнения (perf) и свои треки (tracks)
// по контрактам C2/C3. «Обработчик» здесь — сам тест с токеном из WORKER_TOKEN_SHA256.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Instance, ORIGIN, ROOT, resetStores, songs, sql, valkey } from "./lib.mjs";

const TOKEN = "integration-worker-token-0123456789";
const DATA = mkdtempSync(join(tmpdir(), "perepev-data-"));
process.env.DATA_DIR = DATA;
process.env.WORKER_TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");

// Лимит создания исполнений задаётся окружением (по умолчанию 300 в час с адреса).
const PERF_LIMIT = 7;
const api = new Instance("jobs", 3121, { PERF_LIMIT_PER_HOUR: String(PERF_LIMIT) });
let ip = 0;
const nextIp = () => `10.7.${(++ip) >> 8}.${ip & 255}`;
const browser = (extra = {}) => ({ origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/json", "x-forwarded-for": nextIp(), ...extra });
const post = (path, body, cookie, base = api.base) =>
  fetch(`${base}/api/${path}`, { method: "POST", headers: browser(cookie ? { cookie } : {}), body: JSON.stringify(body) });
const get = (path, cookie, base = api.base) => fetch(`${base}/api/${path}`, { headers: cookie ? { cookie } : {} });
const del = (path, cookie) => fetch(`${api.base}/api/${path}`, { method: "DELETE", headers: browser({ cookie }), body: "{}" });
const putBytes = (path, bytes, type, cookie, base = api.base) =>
  fetch(`${base}/api/${path}`, { method: "PUT", headers: browser({ "content-type": type, ...(cookie ? { cookie } : {}) }), body: bytes });
const cookieOf = (r) => r.headers.get("set-cookie").split(";")[0];

const auth = { authorization: `Bearer ${TOKEN}` };
const worker = (path, { method = "GET", body, type, headers = auth, base = api.base } = {}) =>
  fetch(`${base}/api/worker/${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": type ?? "application/json" }) },
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  });
/** Сигнал жизни обработчика: без него исполнение не создаётся (503), голос не загружается зря. */
const online = async (base = api.base) => assert.equal((await worker("heartbeat", { method: "POST", body: { worker: "it-pc" }, base })).status, 204);
const lease = async (kinds = ["score", "track", "catalog"]) => {
  const r = await worker("lease", { method: "POST", body: { worker: "it-pc", kinds } });
  assert.equal(r.status, 200, "есть задача для обработчика");
  return (await r.json()).job;
};

/** PCM16 LE, 16 кГц моно: синус 220 Гц нужной длительности. */
function pcm(seconds, rate = 16000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return b;
}

function wav(seconds, rate = 44100) {
  const data = pcm(seconds, rate);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let accounts = 0;
async function register(name) {
  const r = await post("register", {
    email: `jobs-${Date.now()}-${accounts++}@example.test`, name, password: "Long-demo-pass-2026", consent: true, ageGroup: "14plus",
  });
  assert.equal(r.status, 201, await r.clone().text());
  return cookieOf(r);
}

const perfBody = (songId, mode = "headphones") => ({ songId, mode, voiceConsent: true, consentVersion: "2026-10-17" });

/** Исполнение: создание, отправка кусков и завершение; возвращает id и cookie гостя. */
async function sing(songId, { cookie, chunks = [pcm(5), pcm(5), pcm(3.87)], mode, base = api.base } = {}) {
  await online(base);
  const r = await post("perf", perfBody(songId, mode), cookie, base);
  assert.equal(r.status, 201, await r.clone().text());
  const { id } = await r.json();
  const owner = cookie ?? cookieOf(r);
  for (const [seq, bytes] of chunks.entries()) {
    assert.equal((await putBytes(`perf/${id}/chunk?seq=${seq}`, bytes, "application/octet-stream", owner, base)).status, 204);
  }
  assert.equal((await post(`perf/${id}/finish`, { chunks: chunks.length }, owner, base)).status, 202);
  return { id, cookie: owner };
}

/** Кадры точно по эталону песни, слова спеты вовремя. */
function perfectOutput(songId, params, bleed = { instrumental: 0.1, guide: 0.05 }) {
  const ref = songId.startsWith("my-") ? songs["cn-earth"] : songs[songId];
  return {
    frames: ref.f0_midi.map((midi, i) => ({ t: Math.round(i * ref.hop_ms) / 1000, midi })),
    words: params.words.map((w) => ({ index: w.index, sung: 1.0, onset_s: w.start_s })),
    asr_text: params.words.map((w) => w.text).join(" "),
    bleed,
    models: { pitch: "torchcrepe-full", asr: "faster-whisper-large-v3-turbo" },
  };
}

before(async () => {
  resetStores();
  await api.start();
});
after(() => {
  api.stop();
  rmSync(DATA, { recursive: true, force: true });
});

describe("очередь GPU-обработчика", { concurrency: false }, () => {
  it("worker auth required", async () => {
    assert.equal((await worker("lease", { method: "POST", body: { worker: "pc-1", kinds: ["score"] }, headers: {} })).status, 401);
    const wrong = { authorization: "Bearer not-the-token" };
    assert.equal((await worker("lease", { method: "POST", body: { worker: "pc-1", kinds: ["score"] }, headers: wrong })).status, 401);
    assert.equal((await worker("heartbeat", { method: "POST", body: { worker: "pc-1" }, headers: wrong })).status, 401);
    assert.equal((await worker(`jobs/${crypto.randomUUID()}/input`, { headers: {} })).status, 401);
    const health = await (await get("health")).json();
    assert.equal(health.worker, false, "неудачная авторизация не считается сигналом жизни");
  });

  it("no worker heartbeat → POST /api/perf 503, nothing stored; worker lost mid-song → offline", async () => {
    valkey("DEL", "kv:worker:seen");
    const before = sql("SELECT count(*) FROM perfs");
    const refused = await post("perf", perfBody("cn-earth"));
    assert.equal(refused.status, 503);
    assert.match((await refused.json()).error, /[А-Яа-я]/);
    assert.equal(refused.headers.get("set-cookie"), null, "гостю не выдаётся cookie");
    assert.equal(sql("SELECT count(*) FROM perfs"), before, "исполнение не создано");
    // Обработчик пропал после начала пения: статус сразу offline.
    const { id, cookie } = await sing("cn-earth");
    valkey("DEL", "kv:worker:seen");
    const r = await (await get(`perf/${id}`, cookie)).json();
    assert.deepEqual(r, { status: "offline", result: null });
    // Задача не должна достаться обработчику в следующих проверках.
    sql(`UPDATE jobs SET status = 'failed', error = 'test' WHERE id = '${id}'`);
  });

  it("worker not configured → POST /api/perf 503 even with a fresh heartbeat", async () => {
    const bare = new Instance("jobs-bare", 3125, { WORKER_TOKEN_SHA256: "" });
    try {
      await bare.start();
      await online();
      const r = await post("perf", perfBody("cn-earth"), null, bare.base);
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /[А-Яа-я]/);
    } finally {
      bare.stop();
    }
  });

  it("guest perf → score job → fake worker complete → done result with precise-1", async () => {
    await online();
    const created = await post("perf", perfBody("cn-earth"));
    assert.equal(created.status, 201);
    assert.match(created.headers.get("set-cookie"), /^perepev_guest=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Strict/);
    const guest = cookieOf(created);
    const { id } = await created.json();
    const chunks = [pcm(5), pcm(5), pcm(3.87)];
    for (const [seq, bytes] of chunks.entries()) {
      assert.equal((await putBytes(`perf/${id}/chunk?seq=${seq}`, bytes, "application/octet-stream", guest)).status, 204);
    }
    assert.equal((await putBytes(`perf/${id}/chunk?seq=0`, pcm(1), "application/json", guest)).status, 415, "только сырой PCM");
    assert.equal((await putBytes(`perf/${id}/chunk?seq=3`, pcm(1), "application/octet-stream")).status, 404, "чужой браузер");
    assert.equal((await post(`perf/${id}/finish`, { chunks: 3 }, guest)).status, 202);
    assert.equal((await post(`perf/${id}/finish`, { chunks: 3 }, guest)).status, 202, "повтор не создаёт вторую задачу");
    assert.equal(sql(`SELECT count(*) FROM jobs WHERE id = '${id}'`), "1");

    const job = await lease();
    assert.equal(job.id, id);
    assert.equal(job.kind, "score");
    assert.equal(job.lease_ttl_s, 120);
    assert.equal(job.params.sample_rate, 16000);
    assert.equal(job.params.language, "ru");
    assert.equal(job.params.duration_s, 13.87);
    assert.equal(job.params.mode, "headphones");
    // Стемы, которые слышал певец: те, что лежат рядом с backing.mp3 песни из каталога.
    const stems = ["instrumental.mp3", "guide.mp3"].filter(n => existsSync(`${ROOT}web/static/songs/cn-earth/${n}`));
    assert.deepEqual(job.params.assets, stems);
    assert.equal(job.params.words.length, 21);
    assert.deepEqual(job.params.words[0], { index: 0, line: 0, text: "Пусть", start_s: 1.4, end_s: 1.54 });
    assert.equal(job.params.words.at(-1).index, 20);
    assert.equal(job.params.words.at(-1).line, 3);

    const running = await (await get(`perf/${id}`, guest)).json();
    assert.equal(running.status, "running");
    const input = await worker(`jobs/${id}/input`);
    assert.equal(input.status, 200);
    assert.equal(input.headers.get("content-type"), "audio/wav");
    const audio = Buffer.from(await input.arrayBuffer());
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.readUInt32LE(24), 16000);
    assert.equal(audio.length, 44 + chunks.reduce((n, c) => n + c.length, 0));
    assert.equal((await worker(`jobs/${id}/progress`, { method: "POST", body: { stage: "words" } })).status, 204);
    assert.equal((await worker(`jobs/${id}/progress`, { method: "POST", body: { stage: "dancing" } })).status, 400);

    const output = perfectOutput("cn-earth", job.params);
    assert.equal((await worker(`jobs/${id}/complete`, { method: "POST", body: output })).status, 204);
    assert.equal((await worker(`jobs/${id}/complete`, { method: "POST", body: output })).status, 204, "идемпотентно");
    const done = await (await get(`perf/${id}`, guest)).json();
    assert.equal(done.status, "done");
    assert.equal(done.result.algorithm, "precise-1");
    assert.equal(done.result.wordsChecked, true);
    assert.equal(done.result.wordsSung, 1);
    assert.equal(done.result.cap, null);
    assert.ok(done.result.score >= 90, `score ${done.result.score}`);
    assert.ok(done.result.axes.rhythm > 0.9);
    assert.equal((await worker(`jobs/${id}/input`)).status, 404, "запись удалена после оценки");
    assert.equal((await get(`perf/${id}`)).status, 404, "результат виден только своему браузеру");
    assert.equal(sql(`SELECT consent_version || ' ' || mode || ' ' || chunks FROM perfs WHERE id = '${id}'`), "2026-10-17 headphones 3");
  });

  it("wordsCheck: false in index.json → score job with words: [], melody-only result without the words cap", async () => {
    // Whisper не находит слов в этих записях даже в исходном вокале: проверка слов выключена.
    const { id, cookie } = await sing("yamshchik-ne-goni");
    const job = await lease(["score"]);
    assert.equal(job.id, id);
    assert.equal(job.params.language, "ru");
    assert.equal(job.params.duration_s, songs["yamshchik-ne-goni"].duration_s);
    assert.deepEqual(job.params.words, [], "слова песни не отправляются обработчику");
    assert.deepEqual(job.params.assets, ["instrumental.mp3", "guide.mp3"]);
    // Обработчик ничего не сопоставил (как Whisper на этой записи): свидетельств слов нет.
    const output = { ...perfectOutput("yamshchik-ne-goni", job.params), words: [], asr_text: "ПЕСНЯ" };
    assert.equal((await worker(`jobs/${id}/complete`, { method: "POST", body: output })).status, 204);
    const done = await (await get(`perf/${id}`, cookie)).json();
    assert.equal(done.status, "done");
    assert.equal(done.result.algorithm, "precise-1");
    assert.equal(done.result.wordsChecked, false);
    assert.notEqual(done.result.cap, "words");
    assert.equal(done.result.cap, null);
    assert.ok(done.result.score >= 90, `score ${done.result.score}`);

    // Две другие песни с флагом тоже без слов; соседняя русская песня того же импорта — со словами.
    for (const [songId, expectWords] of [["oi-to-ne-vecher", false], ["dorogoi-dlinnoyu", false], ["gori-gori-moya-zvezda", true]]) {
      const perf = await sing(songId);
      const leased = await lease(["score"]);
      assert.equal(leased.id, perf.id);
      assert.equal(leased.params.words.length > 0, expectWords, songId);
      assert.equal((await worker(`jobs/${perf.id}/fail`, { method: "POST", body: { error: "test" } })).status, 204);
    }
  });

  it("perf validation, chunk too large → 413, more than 70 s of audio → 413", async () => {
    await online();
    assert.equal((await post("perf", { ...perfBody("cn-earth"), voiceConsent: false })).status, 400);
    assert.equal((await post("perf", perfBody("no-such-song"))).status, 404);
    assert.equal((await post("perf", perfBody("cn-earth", "loud"))).status, 400);
    const r = await post("perf", perfBody("cn-earth"));
    const { id } = await r.json();
    const guest = cookieOf(r);
    assert.equal((await putBytes(`perf/${id}/chunk?seq=0`, Buffer.alloc(400 * 1024 + 2), "application/octet-stream", guest)).status, 413);
    for (let seq = 0; seq < 5; seq++) {
      assert.equal((await putBytes(`perf/${id}/chunk?seq=${seq}`, Buffer.alloc(400 * 1024), "application/octet-stream", guest)).status, 204);
    }
    assert.equal((await putBytes(`perf/${id}/chunk?seq=5`, Buffer.alloc(400 * 1024), "application/octet-stream", guest)).status, 413);
    assert.equal((await post(`perf/${id}/finish`, { chunks: 7 }, guest)).status, 409, "не все куски дошли");
  });

  it("perf rate limit: PERF_LIMIT_PER_HOUR per IP", async () => {
    await online();
    const h = browser({ "x-forwarded-for": "10.77.0.1" });
    const one = () => fetch(`${api.base}/api/perf`, { method: "POST", headers: h, body: JSON.stringify(perfBody("cn-earth")) });
    for (let i = 0; i < PERF_LIMIT; i++) assert.equal((await one()).status, 201);
    assert.equal((await one()).status, 429);
  });

  it("track upload requires login (401)", async () => {
    assert.equal((await post("tracks", { title: "Моя песня", language: "ru" })).status, 401);
    assert.equal((await get("tracks")).status, 401);
  });

  it("owner-only files (other user → 404)", async () => {
    const a = await register("Владелец");
    const b = await register("Сосед");
    const r = await post("tracks", { title: "Секрет", language: "en" }, a);
    assert.equal(r.status, 201);
    const { id } = await r.json();
    assert.equal((await get(`tracks/${id}/files/reference.json`, b)).status, 404);
    assert.equal((await putBytes(`tracks/${id}/audio`, wav(16), "audio/wav", b)).status, 404);
    assert.equal((await del(`tracks/${id}`, b)).status, 404);
    assert.equal((await post("perf", perfBody(`my-${id}`), b)).status, 404);
    assert.deepEqual((await (await get("tracks", b)).json()).tracks, []);
    assert.equal((await (await get("tracks", a)).json()).tracks.length, 1);
    assert.equal((await post("tracks", { title: "", language: "ru" }, a)).status, 400);
    assert.equal((await post("tracks", { title: "Песня", language: "de" }, a)).status, 400);
    assert.equal((await putBytes(`tracks/${id}/audio`, wav(16, 16000), "audio/wav", a)).status, 400, "нужен WAV 44,1 кГц");
  });

  it("6th upload in 24h → 429", async () => {
    const c = await register("Активный");
    for (let i = 0; i < 5; i++) assert.equal((await post("tracks", { title: `Трек ${i}`, language: "ru" }, c)).status, 201);
    assert.equal((await post("tracks", { title: "Шестой", language: "ru" }, c)).status, 429);
  });

  it("track job complete writes files and GET /api/tracks shows ready with expiresAt ≈ +24h", async () => {
    const a = await register("Исполнитель");
    const created = await post("tracks", { title: "Моя песня", language: "ru" }, a);
    const { id } = await created.json();
    const upload = wav(16);
    assert.equal((await putBytes(`tracks/${id}/audio`, upload, "audio/wav", a)).status, 202);
    assert.equal((await putBytes(`tracks/${id}/audio`, upload, "audio/wav", a)).status, 409, "аудио уже загружено");
    let list = (await (await get("tracks", a)).json()).tracks;
    assert.equal(list[0].status, "queued");

    const job = await lease(["track"]);
    assert.equal(job.kind, "track");
    // track_id: обработчик пишет в reference.json id «my-<track_id>», клиент сверяет его с песней.
    assert.deepEqual(job.params, { language: "ru", title: "Моя песня", margin_s: 2.0, track_id: id });
    assert.notEqual(job.id, id, "id задачи и id трека различаются");
    const input = Buffer.from(await (await worker(`jobs/${job.id}/input`)).arrayBuffer());
    assert.deepEqual(input, upload);
    assert.equal((await worker(`jobs/${job.id}/progress`, { method: "POST", body: { stage: "separating" } })).status, 204);
    list = (await (await get("tracks", a)).json()).tracks;
    assert.equal(list[0].status, "running");
    assert.equal(list[0].stage, "separating");

    const dir = `${ROOT}web/static/songs/cn-earth`;
    const files = {
      "reference.json": readFileSync(`${dir}/reference.json`),
      "lyrics.words.json": readFileSync(`${dir}/lyrics.words.json`),
      "backing.mp3": readFileSync(`${dir}/backing.mp3`),
      "instrumental.mp3": readFileSync(`${dir}/backing.mp3`).subarray(0, 50_000),
      "guide.mp3": readFileSync(`${dir}/backing.mp3`).subarray(50_000, 90_000),
    };
    assert.equal((await worker(`jobs/${job.id}/files/run.sh`, { method: "PUT", body: Buffer.from("x"), type: "application/octet-stream" })).status, 400);
    for (const [name, bytes] of Object.entries(files)) {
      assert.equal((await worker(`jobs/${job.id}/files/${name}`, { method: "PUT", body: bytes, type: "application/octet-stream" })).status, 204, name);
    }
    const output = { duration_s: 13.87, lines: 4, words: 21, masked_words: 0, models: { separation: "htdemucs" } };
    assert.equal((await worker(`jobs/${job.id}/complete`, { method: "POST", body: output })).status, 204);
    assert.equal((await worker(`jobs/${job.id}/complete`, { method: "POST", body: output })).status, 204, "идемпотентно");
    assert.equal((await worker(`jobs/${job.id}/input`)).status, 404, "исходный отрывок удалён после обработки");

    list = (await (await get("tracks", a)).json()).tracks;
    assert.equal(list.length, 1);
    assert.deepEqual(
      { ...list[0], expiresAt: undefined },
      { id, title: "Моя песня", language: "ru", status: "ready", stage: null, error: null, expiresAt: undefined },
      "этап виден только у выполняемой задачи",
    );
    const left = Date.parse(list[0].expiresAt) - Date.now();
    assert.ok(Math.abs(left - 24 * 3600_000) < 5 * 60_000, `expiresAt ${list[0].expiresAt}`);
    const ref = await get(`tracks/${id}/files/reference.json`, a);
    assert.equal(ref.status, 200);
    assert.match(ref.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(Buffer.from(await ref.arrayBuffer()), files["reference.json"]);
    const mp3 = await get(`tracks/${id}/files/guide.mp3`, a);
    assert.equal(mp3.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(Buffer.from(await mp3.arrayBuffer()), files["guide.mp3"]);
    assert.equal((await get(`tracks/${id}/files/input.wav`, a)).status, 404);

    // Своя песня поётся как каталожная: стемы и слова берутся из файлов трека.
    const perf = await sing(`my-${id}`, { cookie: a, mode: "speaker" });
    const scoreJob = await lease(["score"]);
    assert.equal(scoreJob.id, perf.id);
    assert.equal(scoreJob.params.language, "ru");
    assert.equal(scoreJob.params.mode, "speaker");
    assert.deepEqual(scoreJob.params.assets, ["instrumental.mp3", "guide.mp3"]);
    assert.equal(scoreJob.params.words.length, 21);
    const guide = await worker(`jobs/${perf.id}/asset/guide.mp3`);
    assert.equal(guide.status, 200);
    assert.deepEqual(Buffer.from(await guide.arrayBuffer()), files["guide.mp3"]);
    assert.equal((await worker(`jobs/${perf.id}/asset/reference.json`)).status, 404);
    const bleed = perfectOutput(`my-${id}`, scoreJob.params, { instrumental: 0.7, guide: 0.6 });
    assert.equal((await worker(`jobs/${perf.id}/complete`, { method: "POST", body: bleed })).status, 204);
    const result = (await (await get(`perf/${perf.id}`, a)).json()).result;
    assert.equal(result.cap, "bleed");
    assert.ok(result.score <= 30);

    assert.equal((await del(`tracks/${id}`, a)).status, 204);
    assert.deepEqual((await (await get("tracks", a)).json()).tracks, []);
    assert.equal((await get(`tracks/${id}/files/reference.json`, a)).status, 404);
  });

  it("data export lists own tracks and precise performances (metadata only)", async () => {
    const a = await register("Выгрузка");
    const { id: track } = await (await post("tracks", { title: "Моя выгрузка", language: "en" }, a)).json();
    const { id: perf } = await sing("cn-earth", { cookie: a, mode: "speaker" });
    const data = await (await get("me/export", a)).json();
    assert.deepEqual(data.own_tracks.map((t) => [t.id, t.title, t.language]), [[track, "Моя выгрузка", "en"]]);
    assert.ok(Date.parse(data.own_tracks[0].expires_at) > Date.now());
    assert.deepEqual(data.precise_performances.map((p) => [p.id, p.song_id, p.mode, p.voice_consent_version, p.chunks]), [[perf, "cn-earth", "speaker", "2026-10-17", 3]]);
    assert.match(data.not_stored, /10 минут/);
    assert.match(data.not_stored, /согласи/);
    assert.doesNotMatch(data.not_stored, /на сервер не передаётся/);
    sql(`UPDATE jobs SET status = 'failed', error = 'test' WHERE id = '${perf}'`);
  });

  it("failed track job shows a Russian error", async () => {
    const a = await register("Неудачник");
    const { id } = await (await post("tracks", { title: "Сломанный", language: "en" }, a)).json();
    assert.equal((await putBytes(`tracks/${id}/audio`, wav(16), "audio/wav", a)).status, 202);
    const job = await lease(["track"]);
    assert.equal((await worker(`jobs/${job.id}/fail`, { method: "POST", body: { error: "CUDA out of memory" } })).status, 204);
    const [t] = (await (await get("tracks", a)).json()).tracks;
    assert.equal(t.status, "failed");
    assert.match(t.error, /[А-Яа-я]/);
    assert.doesNotMatch(t.error, /CUDA/);
    assert.equal((await worker(`jobs/${job.id}/input`)).status, 404);
  });

  it("health reports worker true after lease", async () => {
    const { id } = await sing("cn-earth");
    valkey("DEL", "kv:worker:seen");
    assert.equal((await (await get("health")).json()).worker, false, "сигнала ещё не было");
    // Имя по умолчанию — имя компьютера; на Windows оно бывает кириллическим.
    const r = await worker("lease", { method: "POST", body: { worker: "ДОМАШНИЙ-ПК", kinds: ["score"] } });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).job.id, id);
    const health = await (await get("health")).json();
    assert.equal(health.worker, true);
    assert.equal(health.ok, true);
    assert.equal((await worker(`jobs/${id}/fail`, { method: "POST", body: { error: "test" } })).status, 204);
    assert.equal((await worker("heartbeat", { method: "POST", body: { worker: "" } })).status, 400, "пустое имя");
  });

  it("slow worker: score job misses the deadline → offline", async () => {
    process.env.PERF_DEADLINE_S = "2";
    const slow = new Instance("jobs-slow", 3122);
    try {
      await slow.start();
      assert.equal((await worker("heartbeat", { method: "POST", body: { worker: "it-pc" } })).status, 204);
      const { id, cookie } = await sing("cn-earth", { base: slow.base });
      assert.equal((await (await get(`perf/${id}`, cookie, slow.base)).json()).status, "queued");
      await sleep(2500);
      assert.deepEqual(await (await get(`perf/${id}`, cookie, slow.base)).json(), { status: "offline", result: null });
      sql(`UPDATE jobs SET status = 'failed', error = 'test' WHERE id = '${id}'`);
    } finally {
      slow.stop();
      delete process.env.PERF_DEADLINE_S;
    }
  });

  it("cleanup deletes voice older than 10 min, overdue score jobs and expired tracks", async () => {
    const a = await register("Уборка");
    const { id: track } = await (await post("tracks", { title: "Вчерашний", language: "ru" }, a)).json();
    sql(`UPDATE tracks SET expires_at = now() - interval '1 minute' WHERE id = '${track}'`);
    const trackDir = join(DATA, "tracks", track);
    mkdirSync(trackDir, { recursive: true });
    writeFileSync(join(trackDir, "backing.mp3"), "x");
    // Каталоги без исполнения (например, аккаунт удалён): старый удаляется, свежий остаётся.
    const stale = join(DATA, "jobs", crypto.randomUUID());
    const fresh = join(DATA, "jobs", crypto.randomUUID());
    for (const dir of [stale, fresh]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "chunk-000.pcm"), pcm(1));
    }
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, old, old);
    // Оценка, которую никто не взял за 20 с после конца пения.
    const { id: perf } = await sing("cn-earth");
    sql(`UPDATE jobs SET created_at = now() - interval '30 seconds' WHERE id = '${perf}'`);
    // Вчерашнее исполнение: сведения о нём и его задача хранятся сутки.
    const { id: yesterday } = await sing("cn-earth");
    sql(`UPDATE jobs SET status = 'done', created_at = now() - interval '25 hours' WHERE id = '${yesterday}'`);
    sql(`UPDATE perfs SET created_at = now() - interval '25 hours' WHERE id = '${yesterday}'`);
    // Обращения правообладателей хранятся год.
    sql(`INSERT INTO complaints (id, name, email, url, body, created_at) VALUES
      ('${crypto.randomUUID()}', 'Старое', 'old@example.test', '', 'Давнее обращение', now() - interval '366 days'),
      ('${crypto.randomUUID()}', 'Новое', 'new@example.test', '', 'Свежее обращение', now() - interval '300 days')`);

    const sweeper = new Instance("jobs-sweep", 3123);
    try {
      await sweeper.start(); // первая уборка — сразу при запуске
      for (let i = 0; i < 50 && existsSync(trackDir); i++) await sleep(100);
      assert.equal(existsSync(trackDir), false, "файлы просроченного трека удалены");
      assert.equal(sql(`SELECT count(*) FROM tracks WHERE id = '${track}'`), "0");
      assert.equal(existsSync(stale), false, "запись старше 10 минут удалена");
      assert.equal(existsSync(fresh), true, "свежая запись не тронута");
      assert.equal(sql(`SELECT status || ' ' || error FROM jobs WHERE id = '${perf}'`), "failed deadline");
      assert.equal(existsSync(join(DATA, "jobs", perf)), false, "вход просроченной оценки удалён");
      assert.equal(sql(`SELECT count(*) FROM perfs WHERE id = '${yesterday}'`), "0", "исполнение старше суток удалено");
      assert.equal(sql(`SELECT count(*) FROM jobs WHERE id = '${yesterday}'`), "0", "итог оценки старше суток удалён");
      assert.equal(sql(`SELECT count(*) FROM perfs WHERE id = '${perf}'`), "1", "сегодняшнее исполнение осталось");
      assert.equal(sql("SELECT string_agg(name, ',' ORDER BY name) FROM complaints WHERE name IN ('Старое', 'Новое')"), "Новое", "обращение старше года удалено");
    } finally {
      sweeper.stop();
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("voice never outlives 10 min: a perf with ~9 min old audio is deleted even while chunks keep arriving", async () => {
    // Первый кусок пришёл 9 минут назад, последний — только что: время изменения каталога свежее.
    await online();
    const old = await post("perf", perfBody("cn-earth"));
    const { id } = await old.json();
    const guest = cookieOf(old);
    assert.equal((await putBytes(`perf/${id}/chunk?seq=0`, pcm(5), "application/octet-stream", guest)).status, 204);
    const nineMinutesAgo = new Date(Date.now() - 9 * 60_000);
    sql(`UPDATE perfs SET created_at = now() - interval '9 minutes' WHERE id = '${id}'`);
    utimesSync(join(DATA, "jobs", id, "chunk-000.pcm"), nineMinutesAgo, nineMinutesAgo);
    assert.equal((await putBytes(`perf/${id}/chunk?seq=1`, pcm(5), "application/octet-stream", guest)).status, 204);
    // Исполнение, которое поётся прямо сейчас, не трогается.
    const now = await post("perf", perfBody("cn-earth"));
    const { id: current } = await now.json();
    assert.equal((await putBytes(`perf/${current}/chunk?seq=0`, pcm(5), "application/octet-stream", cookieOf(now))).status, 204);

    const sweeper = new Instance("jobs-voice", 3124);
    try {
      await sweeper.start(); // первая уборка — сразу при запуске
      const dir = join(DATA, "jobs", id);
      for (let i = 0; i < 50 && existsSync(dir); i++) await sleep(100);
      assert.equal(existsSync(dir), false, "запись голоса удалена до истечения 10 минут");
      assert.equal(existsSync(join(DATA, "jobs", current, "chunk-000.pcm")), true, "текущее исполнение не тронуто");
      assert.equal((await post(`perf/${id}/finish`, { chunks: 2 }, guest)).status, 409, "оценивать уже нечего");
    } finally {
      sweeper.stop();
    }
  });
});
