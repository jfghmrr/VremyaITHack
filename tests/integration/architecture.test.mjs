// Проверки архитектуры: node --test tests/integration/
// Требуют собранного target/release/perepev-api, локальных PostgreSQL и Valkey.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Instance, ORIGIN, Player, curve, ratedMatch, resetStores, sql, valkey } from "./lib.mjs";

const A = new Instance("alpha", 3101);
const B = new Instance("beta", 3102);
const players = [];
const player = async (name, inst) => {
  const p = await (await new Player(name).register(inst)).connect(inst);
  players.push(p);
  return p;
};

before(async () => {
  resetStores();
  await A.start();
  await B.start();
});

after(() => {
  for (const p of players) p.disconnect();
  A.stop();
  B.stop();
});

describe("два экземпляра API", { concurrency: false }, () => {
  it("подбор между экземплярами, одновременное пение и одинаковый подтверждённый результат", async () => {
    const a = await player("Альфа", A);
    const b = await player("Бета", B);
    const id = await ratedMatch(a, b);
    const song = a.view.song.id;
    await Promise.all([a.sing(curve(song, -5)), b.sing(curve(song, 3, [[100, 200, 1.6]]))]);
    await a.state("finished", 40_000);
    await b.state("finished", 40_000);
    assert.deepEqual(a.view.result, b.view.result, "оба участника получают один результат");
    const mine = a.view.result.players.find((p) => p.user_id === a.id);
    assert.equal(mine.outcome, "win");
    assert.equal(a.view.result.technical, false);
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "2");
    assert.equal(sql(`SELECT state FROM matches WHERE id = '${id}'`), "finished");
    assert.equal(sql(`SELECT count(*) FROM match_participants WHERE match_id = '${id}' AND active`), "0");
    // Сумма изменений Elo при равных стартовых MMR равна нулю.
    assert.equal(sql(`SELECT round(sum(mmr_after - mmr_before)::numeric, 9) FROM rating_events WHERE match_id = '${id}'`), "0.000000000");
  });

  it("переподключение на другой экземпляр посреди пения: данные дозаливаются, время не добавляется", async () => {
    const a = await player("Гамма", A);
    const b = await player("Дельта", B);
    const id = await ratedMatch(a, b);
    const song = a.view.song.id;
    const pointsA = curve(song, 2);
    const singB = b.sing(curve(song, -2, [[220, 300, 2]]));
    // Альфа поёт 7 секунд, теряет соединение, возвращается через другой экземпляр.
    await a.sing(pointsA, { stopAt: 7 });
    a.disconnect();
    await sleep(2500);
    await a.connect(B);
    await a.waitFor(() => a.view?.match_id === id && !a.closed, 10_000, "состояние после переподключения");
    await Promise.all([a.sing(pointsA), singB]);
    await a.state("finished", 40_000);
    await b.state("finished", 40_000);
    assert.equal(a.view.result.technical, false, "кривая восстановлена полностью");
    assert.deepEqual(a.view.result, b.view.result);
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "2");
  });

  it("потеря владельца матча: другой экземпляр перехватывает аренду, результат один", async () => {
    const a = await player("Эпсилон", A);
    const b = await player("Зета", B);
    const id = await ratedMatch(a, b);
    const song = a.view.song.id;
    const owner = valkey("GET", `kv:m:${id}:owner`);
    const [ownerName, gen] = owner.split(":");
    const victim = ownerName === "alpha" ? A : B;
    const survivor = victim === A ? B : A;
    const pa = curve(song, 0);
    const pb = curve(song, 5, [[50, 120, 1.7]]);
    await Promise.all([a.sing(pa, { stopAt: 6 }), b.sing(pb, { stopAt: 6 })]);
    victim.kill();
    // Клиенты убитого экземпляра переподключаются к оставшемуся.
    for (const p of [a, b]) if (p.instance === victim) (await sleep(500), await p.connect(survivor));
    await Promise.all([a.sing(pa), b.sing(pb)]);
    await a.state("finished", 60_000);
    await b.state("finished", 60_000);
    const newOwnerGen = Number(sql(`SELECT owner_gen FROM matches WHERE id = '${id}'`));
    assert.ok(newOwnerGen > Number(gen), `поколение владельца выросло: ${gen} → ${newOwnerGen}`);
    assert.equal(a.view.result.technical, false);
    assert.deepEqual(a.view.result, b.view.result);
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "2", "рейтинг применён один раз");
    await victim.start();
  });

  it("разрыв без возврата во время пения — техническое поражение по правилу, рейтинг один раз", async () => {
    const a = await player("Эта", A);
    const b = await player("Тета", B);
    const id = await ratedMatch(a, b);
    const song = a.view.song.id;
    const singA = a.sing(curve(song, 1));
    await b.sing(curve(song, -1), { stopAt: 5 });
    b.disconnect();
    await singA;
    await a.state("finished", 60_000);
    const res = a.view.result;
    assert.equal(res.technical, true);
    assert.equal(a.view.end_reason, "disconnected");
    assert.equal(res.players.find((p) => p.user_id === a.id).outcome, "win");
    assert.equal(res.players.find((p) => p.user_id === b.id).outcome, "loss");
    assert.equal(res.players.find((p) => p.user_id === b.id).score, null, "неполная кривая не оценивается");
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "2");
  });

  it("очередь: повтор входа не создаёт вторую заявку, отменённая заявка не даёт матча", async () => {
    const c = await player("Йота", A);
    const d = await player("Каппа", B);
    await Promise.all([c.send({ type: "queue_join" }), c.send({ type: "queue_join" })]);
    assert.equal(valkey("ZCOUNT", "kv:q:pool:cal", "-inf", "+inf"), "1");
    await c.send({ type: "queue_leave" });
    assert.equal(valkey("EXISTS", `kv:q:t:${c.id}`), "0");
    // Быстрые вход/выход Йоты, пока Каппа ждёт: матч возможен только при живой заявке.
    await d.send({ type: "queue_join" });
    for (let i = 0; i < 15; i++) {
      await c.send({ type: "queue_join" });
      await c.send({ type: "queue_leave" });
    }
    await sleep(1500);
    // Инвариант гонки: отмена, обработанная до формирования пары, не даёт матча; если пара
    // сформировалась раньше отмены, игрок получил её явно — «тихих» матчей нет.
    const live = sql(`SELECT m.id FROM matches m JOIN match_participants p ON p.match_id = m.id WHERE p.user_id = '${c.id}' AND m.state <> 'cancelled'`);
    for (const id of live.split("\n").filter(Boolean)) assert.equal(c.view?.match_id, id, "матч не скрыт от игрока");
    if (c.view && !["cancelled", "finished", "failed"].includes(c.view.state)) await c.send({ type: "decline", match_id: c.view.match_id });
    await d.send({ type: "queue_leave" });
    await sleep(1000);
    assert.equal(sql(`SELECT count(*) FROM match_participants WHERE user_id IN ('${c.id}', '${d.id}') AND active`), "0");
  });

  it("защита новичка держится при долгом ожидании и пустой очереди", async () => {
    const newbie = await new Player("Новичок").register(A);
    const star = await new Player("Звезда").register(B);
    const peer = await new Player("Ровня").register(A);
    sql(`INSERT INTO ratings (user_id, mmr, peak_mmr, rated_matches) VALUES
      ('${newbie.id}', 1090, 1090, 12), ('${star.id}', 1180, 1450, 80), ('${peer.id}', 1150, 1150, 40)`);
    for (const p of [newbie, star]) {
      await p.connect(p === newbie ? A : B);
      players.push(p);
      await p.send({ type: "queue_join" });
    }
    // Имитируем час ожидания: окно у обоих на максимуме. Новичок ждёт чуть дольше,
    // поэтому при появлении подходящего соперника приоритет у него.
    const hourAgo = Date.now() - 3_600_000;
    for (const [p, at] of [[newbie, hourAgo], [star, hourAgo + 60_000]]) {
      valkey("HSET", `kv:q:t:${p.id}`, "joined", String(at));
      valkey("ZADD", "kv:q:pool:main", String(at), p.id);
    }
    await sleep(3000);
    assert.equal(newbie.queue?.status, "searching", "новичок не сведён со звездой");
    assert.ok(newbie.queue.window <= 100, `окно новичка ограничено: ${newbie.queue.window}`);
    await peer.connect(A);
    players.push(peer);
    await peer.send({ type: "queue_join" });
    await newbie.waitFor(() => newbie.view?.state === "waiting", 10_000, "подходящий соперник");
    assert.ok(newbie.view.players.some((p) => p.user_id === peer.id));
    assert.equal(star.queue?.status, "searching");
    await newbie.send({ type: "decline", match_id: newbie.view.match_id });
    await star.send({ type: "queue_leave" });
  });

  it("лимит повторяющихся рейтинговых пар: после трёх матчей за сутки пара не сводится", async () => {
    const x = await new Player("Икс").register(A);
    const y = await new Player("Игрек").register(B);
    const z = await new Player("Зет").register(A);
    sql(`INSERT INTO ratings (user_id, mmr, peak_mmr, rated_matches) VALUES
      ('${x.id}', 1250, 1250, 30), ('${y.id}', 1255, 1255, 30), ('${z.id}', 1260, 1260, 30)`);
    for (let i = 0; i < 3; i++) {
      const m = sql(`INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s)
        VALUES (gen_random_uuid(), 'rated', 'finished', 'ode', 'x', 1, 20) RETURNING id`).split("\n")[0];
      sql(`INSERT INTO match_participants (match_id, user_id, slot, active) VALUES ('${m}', '${x.id}', 0, false), ('${m}', '${y.id}', 1, false)`);
    }
    for (const [p, inst] of [[x, A], [y, B]]) {
      await p.connect(inst);
      players.push(p);
      await p.send({ type: "queue_join" });
    }
    await sleep(3000);
    assert.equal(x.view, null, "пара с исчерпанным лимитом не сведена");
    assert.equal(x.queue?.status, "searching");
    await z.connect(A);
    players.push(z);
    await z.send({ type: "queue_join" });
    await z.waitFor(() => z.view?.state === "waiting", 10_000, "матч с другим игроком");
    const mates = z.view.players.map((p) => p.user_id);
    assert.ok(mates.includes(x.id) || mates.includes(y.id));
    for (const p of [x, y, z]) {
      if (p.view && p.view.state === "waiting") await p.send({ type: "decline", match_id: p.view.match_id });
      await p.send({ type: "queue_leave" });
    }
  });

  it("выход из кабинета закрывает WebSocket на любом экземпляре", async () => {
    const p = await new Player("Лямбда").register(A);
    await p.connect(B);
    players.push(p);
    const r = await fetch(`${A.base}/api/logout`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/json", cookie: p.cookie },
      body: "{}",
    });
    assert.equal(r.status, 200);
    await p.waitFor(() => p.closed, 3000, "закрытие соединения");
    // Повторное подключение с отозванной сессией отклоняется.
    await assert.rejects(p.connect(B));
  });

  it("чужой Origin и запрос без сессии к WebSocket отклоняются", async () => {
    const p = await new Player("Мю").register(A);
    const bad = new WebSocket(`ws://127.0.0.1:${A.port}/api/ws`, { headers: { origin: "https://evil.test", cookie: p.cookie } });
    const code = await new Promise((r) => ((bad.onclose = (e) => r(e.code)), (bad.onerror = () => {})));
    assert.equal(code, 1006);
    const anon = new WebSocket(`ws://127.0.0.1:${A.port}/api/ws`, { headers: { origin: ORIGIN } });
    assert.equal(await new Promise((r) => ((anon.onclose = (e) => r(e.code)), (anon.onerror = () => {}))), 1006);
  });
});
