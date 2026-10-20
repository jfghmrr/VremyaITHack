// Надёжность рейтингового поиска: node --test tests/integration/matchmaking.test.mjs
// Поиск всегда говорит правду: почему пары нет (лимит пары, разница уровня, пул калибровки,
// никого нет), не крутится после того, как сервер заявку снял, а калибровка и основной пул
// встречаются после ожидания. Требует собранного target/release/perepev-api, PostgreSQL и Valkey.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Instance, Player, resetStores, sql, valkey } from "./lib.mjs";

const A = new Instance("mm-alpha", 3111);
const players = [];
let current = [];

before(async () => {
  resetStores();
  await A.start();
});

after(() => {
  for (const p of players) p.disconnect();
  A.stop();
});

async function make(name, rating) {
  const p = await new Player(name).register(A);
  if (rating) {
    const [mmr, n] = rating;
    sql(`INSERT INTO ratings (user_id, mmr, peak_mmr, rated_matches) VALUES ('${p.id}', ${mmr}, ${mmr}, ${n})`);
  }
  await p.connect(A);
  players.push(p);
  current.push(p);
  return p;
}

/** Ожидание в поиске «уже длилось» `ms`: время входа в заявке и в пуле сдвигается назад. */
function waited(p, ms) {
  const at = Date.now() - ms;
  const pool = valkey("HGET", `kv:q:t:${p.id}`, "pool");
  valkey("HSET", `kv:q:t:${p.id}`, "joined", String(at));
  valkey("ZADD", `kv:q:pool:${pool}`, String(at), p.id);
}

async function leaveAll(...ps) {
  for (const p of ps) {
    if (p.view && ["created", "waiting", "ready_check"].includes(p.view.state)) await p.send({ type: "decline", match_id: p.view.match_id });
    await p.send({ type: "queue_leave" });
  }
}

const note = (p) => p.queue?.note ?? "";

// Упавшая проверка не оставляет игроков в очереди и в матчах: следующая начинает с пустой очередью.
afterEach(async () => {
  for (const p of current) {
    if (p.closed) continue;
    const id = p.view?.match_id;
    if (id && !["finished", "cancelled", "failed"].includes(p.view.state)) await p.send({ type: p.view.kind === "friend" ? "leave" : "decline", match_id: id });
    await p.send({ type: "queue_leave" });
    p.disconnect();
  }
  current = [];
  await sleep(300);
});

describe("рейтинговый поиск", { concurrency: false }, () => {
  it("один в поиске видит, что больше никто не ищет", async () => {
    const a = await make("Одиночка");
    await a.send({ type: "queue_join" });
    await a.waitFor(() => /никто/.test(note(a)), 5000, "пояснение «больше никто не ищет»");
    assert.equal(a.queue.status, "searching");
    // После 30 секунд поиска пояснение предлагает другие способы спеть.
    waited(a, 31_000);
    await a.waitFor(() => /спеть с призраком/.test(note(a)), 5000, "предложение после 30 секунд");
    await leaveAll(a);
  });

  it("лимит пары: обоим объяснено, почему подбор их не сводит", async () => {
    const x = await make("Лимит-Икс", [1250, 30]);
    const y = await make("Лимит-Игрек", [1255, 30]);
    for (let i = 0; i < 3; i++) {
      const m = sql(`INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s, created_at)
        VALUES (gen_random_uuid(), 'rated', 'finished', 'cn-earth', 'x', 1, 20, now() - interval '1 hour') RETURNING id`).split("\n")[0];
      sql(`INSERT INTO match_participants (match_id, user_id, slot, active) VALUES ('${m}', '${x.id}', 0, false), ('${m}', '${y.id}', 1, false)`);
    }
    await x.send({ type: "queue_join" });
    await y.send({ type: "queue_join" });
    for (const p of [x, y]) await p.waitFor(() => /3 рейтинговых матча/.test(note(p)), 5000, "пояснение о лимите пары");
    assert.equal(x.view, null, "пара с исчерпанным лимитом не сведена");
    assert.match(note(x), /без рейтинга/, "предложен способ сыграть всё равно");
    await leaveAll(x, y);
  });

  it("лимит пары важнее разницы уровня: пояснение не обещает подбор, которого не будет", async () => {
    // Те же двое тестовых аккаунтов после трёх матчей подряд: разница 107 MMR (окно дорастёт
    // через 30 с), но лимит пары исчерпан — пояснение сразу о лимите.
    const x = await make("Лимит-Окно-А", [1053, 3]);
    const y = await make("Лимит-Окно-Б", [946, 3]);
    for (let i = 0; i < 3; i++) {
      const m = sql(`INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s, created_at)
        VALUES (gen_random_uuid(), 'rated', 'finished', 'cn-earth', 'x', 1, 20, now() - interval '1 hour') RETURNING id`).split("\n")[0];
      sql(`INSERT INTO match_participants (match_id, user_id, slot, active) VALUES ('${m}', '${x.id}', 0, false), ('${m}', '${y.id}', 1, false)`);
    }
    await x.send({ type: "queue_join" });
    await y.send({ type: "queue_join" });
    for (const p of [x, y]) await p.waitFor(() => /3 рейтинговых матча/.test(note(p)), 5000, "пояснение о лимите пары, а не об окне");
    await leaveAll(x, y);
  });

  it("разница уровня больше окна: пояснение, затем подбор, когда окно дорастает", async () => {
    const a = await make("Окно-А", [1000, 30]);
    const b = await make("Окно-Б", [1107, 30]);
    await a.send({ type: "queue_join" });
    await b.send({ type: "queue_join" });
    for (const p of [a, b]) await p.waitFor(() => /разница уровня/.test(note(p)), 5000, "пояснение о разнице уровня");
    // Пояснение не раскрывает MMR другого игрока (он может быть и на калибровке).
    for (const p of [a, b]) assert.doesNotMatch(note(p), /\d+\s*MMR/);
    assert.equal(a.view, null);
    // Оба ждут 30 с: окно ±120 вмещает разницу 107.
    waited(a, 31_000);
    waited(b, 31_000);
    await a.waitFor(() => a.view?.state === "waiting", 5000, "подбор после расширения окна");
    assert.equal(b.view?.match_id, a.view.match_id);
    await leaveAll(a, b);
  });

  it("калибровка и прошедший её игрок: пояснение, затем подбор после ожидания", async () => {
    const fresh = await make("Новенький", [1000, 4]);
    const vet = await make("Бывалый", [1030, 14]);
    await fresh.send({ type: "queue_join" });
    await vet.send({ type: "queue_join" });
    assert.equal(fresh.queue.pool, "cal");
    assert.equal(vet.queue.pool, "main");
    for (const p of [fresh, vet]) await p.waitFor(() => /калибровк/.test(note(p)), 5000, "пояснение о пуле калибровки");
    await sleep(1000);
    assert.equal(fresh.view, null, "до ожидания пулы раздельны");
    waited(fresh, 31_000);
    waited(vet, 31_000);
    await fresh.waitFor(() => fresh.view?.state === "waiting", 5000, "подбор между пулами после ожидания");
    assert.equal(vet.view?.match_id, fresh.view.match_id);
    await leaveAll(fresh, vet);
  });

  it("защита новичков действует и между пулами", async () => {
    const newbie = await make("Защищённый", [1080, 12]);
    const star = await make("Сильная", [1060, 4]);
    sql(`UPDATE ratings SET peak_mmr = 1450 WHERE user_id = '${star.id}'`);
    await newbie.send({ type: "queue_join" });
    await star.send({ type: "queue_join" });
    waited(newbie, 3_600_000);
    waited(star, 3_600_000);
    await sleep(2500);
    assert.equal(newbie.view, null, "новичок не сведён с сильным по истории игроком");
    await leaveAll(newbie, star);
  });

  it("заявка, снятая сервером, не оставляет вечный поиск на экране", async () => {
    const a = await make("Пропажа");
    await a.send({ type: "queue_join" });
    assert.equal(a.queue.status, "searching");
    // Заявка пропала на сервере (истекла, пока вкладка спала, сбой Valkey): ближайший heartbeat сообщает об этом.
    valkey("DEL", `kv:q:t:${a.id}`);
    await a.waitFor(() => a.queue?.status === "idle", 6000, "сообщение о снятой заявке");
  });

  it("вход в комнату друга снимает рейтинговый поиск и говорит об этом", async () => {
    const host = await make("Хозяин");
    const a = await make("Гость-в-поиске");
    const b = await make("Ждущий");
    await a.send({ type: "queue_join" });
    await host.send({ type: "room_create", song_id: "cn-earth" });
    const code = host.events.findLast((e) => e.type === "room").code;
    assert.equal((await a.send({ type: "room_join", code })).ok, true);
    await a.waitFor(() => a.queue?.status === "idle", 3000, "поиск снят при входе в комнату");
    assert.equal(valkey("EXISTS", `kv:q:t:${a.id}`), "0");
    // Второй игрок в очереди не сводится с тем, кто уже в комнате.
    await b.send({ type: "queue_join" });
    await sleep(1500);
    assert.equal(b.view, null);
    assert.equal(b.queue.status, "searching");
    for (const p of [host, a]) await p.send({ type: "leave", match_id: host.view.match_id });
    await leaveAll(b);
  });

  it("комната, созданная из поиска, и реванш снимают рейтинговый поиск", async () => {
    const a = await make("Создатель-в-поиске");
    await a.send({ type: "queue_join" });
    assert.equal((await a.send({ type: "room_create", song_id: "cn-earth" })).ok, true);
    await a.waitFor(() => a.queue?.status === "idle" && /комнат/.test(note(a)), 3000, "поиск снят при создании комнаты");
    assert.equal(valkey("EXISTS", `kv:q:t:${a.id}`), "0");
    const room = a.events.findLast((e) => e.type === "room");
    const b = await make("Гость-реванша");
    await b.send({ type: "room_join", code: room.code });
    await a.waitFor(() => a.view?.match_id === room.match_id && a.view.state === "ready_check", 5000, "комната готова");
    await a.send({ type: "leave", match_id: room.match_id });
    await b.waitFor(() => b.view?.state === "cancelled", 5000, "отмена комнаты");
    // Б ищет соперника и нажимает «Реванш»: комната реванша снимает его рейтинговый поиск.
    await b.send({ type: "queue_join" });
    assert.equal(b.queue.status, "searching");
    assert.equal((await b.send({ type: "rematch", match_id: room.match_id })).ok, true);
    await b.waitFor(() => b.queue?.status === "idle" && /комнат/.test(note(b)), 3000, "поиск снят реваншем");
    assert.equal(valkey("EXISTS", `kv:q:t:${b.id}`), "0");
    const rematch = b.events.findLast((e) => e.type === "room" && e.invite === false).match_id;
    await b.send({ type: "leave", match_id: rematch });
  });

  it("неудачный вход в комнату или реванш не снимают поиск и не пишут ложного пояснения", async () => {
    const a = await make("Промах");
    await a.send({ type: "queue_join" });
    const since = a.queue.since_ms;
    const from = a.events.length;
    const wrong = await a.send({ type: "room_join", code: "ZZZZZZ" });
    assert.equal(wrong.ok, false);
    const stale = await a.send({ type: "rematch", match_id: "00000000-0000-4000-8000-000000000000" });
    assert.equal(stale.ok, false);
    await sleep(1500);
    assert.equal(a.queue.status, "searching", "поиск продолжается");
    assert.equal(a.queue.since_ms, since, "приоритет ожидания прежний");
    assert.equal(valkey("HGET", `kv:q:t:${a.id}`, "state"), "queued");
    assert.equal(a.events.slice(from).some((e) => e.type === "queue" && e.state.status === "idle"), false, "ни одного «поиск остановлен»");
  });

  it("заявка игрока, который уже в другом матче, снимается подбором с пояснением", async () => {
    const a = await make("Занятой");
    const b = await make("Ждёт-пару");
    await a.send({ type: "queue_join" });
    // Игрок оказался в другом матче, пока его заявка ждала (например, вошёл в комнату на другом экземпляре).
    const m = sql(`INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s)
      VALUES (gen_random_uuid(), 'friend', 'waiting', 'cn-earth', 'x', 1, 20) RETURNING id`).split("\n")[0];
    sql(`INSERT INTO match_participants (match_id, user_id, slot) VALUES ('${m}', '${a.id}', 0)`);
    try {
      await b.send({ type: "queue_join" });
      await a.waitFor(() => a.queue?.status === "idle" && /другом матче/.test(note(a)), 5000, "сообщение о снятой заявке");
      assert.equal(valkey("EXISTS", `kv:q:t:${a.id}`), "0");
      await sleep(600);
      assert.equal(b.queue.status, "searching", "второй игрок ищет дальше");
      assert.equal(b.view, null);
    } finally {
      sql(`UPDATE match_participants SET active = false WHERE match_id = '${m}'`);
      sql(`UPDATE matches SET state = 'cancelled', finished_at = now() WHERE id = '${m}'`);
    }
  });

  it("после переподключения состояние матча приходит раньше состояния очереди", async () => {
    const a = await make("Порядок-А");
    const b = await make("Порядок-Б");
    await a.send({ type: "queue_join" });
    await b.send({ type: "queue_join" });
    await a.waitFor(() => a.view?.state === "waiting", 5000, "match found");
    const id = a.view.match_id;
    a.disconnect();
    await sleep(300);
    a.events = [];
    await a.connect(A);
    await a.waitFor(() => a.events.some((e) => e.type === "queue") && a.events.some((e) => e.type === "match"), 5000, "состояние после hello");
    const types = a.events.filter((e) => e.type === "queue" || e.type === "match").map((e) => e.type);
    assert.equal(types[0], "match", `сначала активный матч, потом очередь: ${types.join(",")}`);
    assert.equal(a.view.match_id, id);
    await a.send({ type: "decline", match_id: id });
  });
});
