// Режим «Вместе»: комната друга, расписание ходов от сервера, оценка партий и общий балл.
// node --test tests/integration/coop.test.mjs — нужен собранный target/release/perepev-api.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Instance, ORIGIN, Player, curve, resetStores, songVersion, sql } from "./lib.mjs";

// Общий DATA_DIR обоих экземпляров: голос, принятый одним, отдаёт другой.
const DATA = mkdtempSync(join(tmpdir(), "perepev-coop-"));
process.env.DATA_DIR = DATA;
const A = new Instance("coop-a", 3111);
const B = new Instance("coop-b", 3112);
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
  rmSync(DATA, { recursive: true, force: true });
});

/** Комната друга до общего старта: `mode` не передаётся, если не задан (как у прежних клиентов). */
async function friendRoom(a, b, song, mode) {
  await a.send({ type: "room_create", song_id: song, ...(mode ? { mode } : {}) });
  const room = a.events.findLast((e) => e.type === "room");
  await b.send({ type: "room_join", code: room.code });
  await a.waitFor(() => a.view?.room_code === room.code && a.view.state === "ready_check", 10_000, "готовность");
  await b.waitFor(() => b.view?.room_code === room.code && b.view.state === "ready_check", 10_000, "готовность");
  const id = a.view.match_id;
  const version = await songVersion(a.instance, song);
  for (const p of [a, b]) await p.send({ type: "ready", match_id: id, song_version: version, algorithm_version: 1 });
  for (const p of [a, b]) await p.waitFor(() => p.view?.start_at_ms != null, 10_000, "старт");
  return { id, room };
}

/** Индекс точки 50 мс попадает в ходы участника. */
const inTurns = (turns, slot, i) => turns.some((t) => t.slot === slot && i * 0.05 >= t.start_s && i * 0.05 < t.end_s);

describe("«Вместе»", { concurrency: false }, () => {
  it("комната «Вместе»: ходы по очереди, партии и общий балл; чужие точки не считаются", async () => {
    const a = await player("Вера", A);
    const b = await player("Глеб", B);
    const song = "cn-earth";
    const { id, room } = await friendRoom(a, b, song, "coop");
    assert.equal(room.mode, "coop", "сообщение комнаты называет режим");
    const view = a.view;
    assert.equal(view.mode, "coop");
    assert.equal(view.kind, "friend");
    assert.deepEqual(b.view.turns, view.turns, "оба получают одно расписание");
    // Ходы чередуются с создателя комнаты, в ходе одна или две строки, окна не перекрываются.
    assert.ok(view.turns.length >= 2);
    view.turns.forEach((t, k) => {
      assert.equal(t.slot, k % 2);
      assert.ok(t.lines.length >= 1 && t.lines.length <= 2);
      if (k) assert.ok(view.turns[k - 1].end_s <= t.start_s);
    });
    const slotA = view.players.find((p) => p.user_id === a.id).slot;
    const slotB = 1 - slotA;
    // Вера поёт свою партию точно, а в ходы Глеба шлёт фальшь: сервер её не учитывает.
    const pa = curve(song, -4).map((v, i) => (inTurns(view.turns, slotA, i) ? v : v === null ? 700 : v + 37));
    // Глеб поёт только свои ходы, в своей тональности и с ошибкой в одном месте.
    const pb = curve(song, 3).map((v, i) => (inTurns(view.turns, slotB, i) ? v : null));
    await Promise.all([a.sing(pa), b.sing(pb)]);
    await a.state("finished", 40_000);
    await b.state("finished", 40_000);
    const res = a.view.result;
    assert.deepEqual(res, b.view.result, "один подтверждённый результат");
    assert.equal(res.rated, false);
    assert.equal(res.technical, false);
    assert.ok(res.players.every((p) => p.outcome === "draw"), "без победителя");
    const team = res.team;
    assert.ok(team, "есть общий итог");
    assert.equal(team.parts.length, 2);
    const partA = team.parts.find((p) => p.user_id === a.id);
    const partB = team.parts.find((p) => p.user_id === b.id);
    assert.ok(partA.score > 90, `партия Веры ${partA.score}: фальшь в чужих ходах не считается`);
    assert.ok(partB.score > 90, `партия Глеба ${partB.score}`);
    assert.equal(partA.turns + partB.turns, view.turns.length);
    assert.ok(partA.seconds > 0 && partB.seconds > 0);
    const weighted = Math.round(((partA.score * partA.seconds + partB.score * partB.seconds) / (partA.seconds + partB.seconds)) * 10) / 10;
    assert.ok(Math.abs(team.score - weighted) <= 0.1, `общий балл ${team.score} ≈ ${weighted}`);
    assert.equal(res.players.find((p) => p.user_id === a.id).score, partA.score, "балл игрока — его партия");
    assert.equal(sql(`SELECT mode FROM matches WHERE id = '${id}'`), "coop");
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "0", "рейтинг не меняется");
    // Итог из базы (после закрытия вкладки) тот же и с тем же расписанием.
    const fromApi = await (await fetch(`${A.base}/api/matches/${id}`, { headers: { cookie: a.cookie } })).json();
    assert.equal(fromApi.mode, "coop");
    assert.deepEqual(fromApi.turns, view.turns);
    assert.deepEqual(fromApi.result.team, team);
    const list = await (await fetch(`${A.base}/api/matches`, { headers: { cookie: a.cookie } })).json();
    assert.equal(list.matches.find((m) => m.id === id).mode, "coop");

    // Реванш «Вместе» — снова «Вместе» с той же песней; приглашение называет режим.
    await a.send({ type: "rematch", match_id: id });
    const own = a.events.findLast((e) => e.type === "room");
    assert.equal(own.mode, "coop");
    await b.waitFor(() => b.events.some((e) => e.type === "room" && e.invite === true && e.rematch_of === id), 10_000, "приглашение");
    assert.equal(b.events.findLast((e) => e.type === "room" && e.invite === true).mode, "coop");
    await a.waitFor(() => a.view?.match_id === own.match_id, 10_000, "комната реванша");
    assert.equal(a.view.mode, "coop");
    assert.equal(a.view.song.id, song);
    await a.send({ type: "leave", match_id: own.match_id });
    await a.state("cancelled", 10_000);
  });

  it("тишина в свои ходы — низкая партия, общий балл ниже", async () => {
    const a = await player("Дина", A);
    const b = await player("Егор", A);
    const song = "cn-earth";
    const { id } = await friendRoom(a, b, song, "coop");
    const turns = a.view.turns;
    const slotA = a.view.players.find((p) => p.user_id === a.id).slot;
    const pa = curve(song, 0).map((v, i) => (inTurns(turns, slotA, i) ? v : null));
    // Егор молчит всю песню.
    const pb = curve(song, 0).map(() => null);
    await Promise.all([a.sing(pa), b.sing(pb)]);
    await a.state("finished", 40_000);
    const team = a.view.result.team;
    const partA = team.parts.find((p) => p.user_id === a.id);
    const partB = team.parts.find((p) => p.user_id === b.id);
    assert.ok(partA.score > 90, `партия Дины ${partA.score}`);
    assert.ok(partB.score <= 30, `партия Егора ${partB.score}`);
    assert.ok(team.score < partA.score && team.score > partB.score, `общий ${team.score}`);
    assert.ok(partB.hardest && partB.hardest.reason === "missing", "трудное место Егора — несыгранная часть");
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "0");
  });

  it("настоящие голоса: только с согласия обоих, только свои ходы, недолго", async () => {
    const a = await player("Ия", A);
    const b = await player("Кира", B);
    const outsider = await player("Лев", A);
    const song = "cn-earth";
    await a.send({ type: "room_create", song_id: song, mode: "coop" });
    const room = a.events.findLast((e) => e.type === "room");
    await b.send({ type: "room_join", code: room.code });
    await a.waitFor(() => a.view?.room_code === room.code && a.view.state === "ready_check", 10_000, "готовность");
    const id = a.view.match_id;
    const voice = (p, method, path, body) =>
      fetch(`${(p.instance ?? A).base}/api/matches/${id}/voice${path}`, {
        method,
        headers: { origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/octet-stream", cookie: p.cookie },
        body,
      });
    const pcm = (seconds, value = 1000) => Buffer.from(new Int16Array(Math.round(seconds * 16000)).fill(value).buffer);
    // По умолчанию согласия нет; согласна только Ия — голос не принимается и не отдаётся.
    assert.ok(a.view.players.every((p) => p.share_voice === false));
    await a.send({ type: "voice_share", match_id: id, on: true });
    await b.waitFor(() => b.view?.players.find((p) => p.user_id === a.id)?.share_voice === true, 10_000, "согласие Ии видно Кире");
    assert.equal((await voice(a, "PUT", "", pcm(1))).status, 403, "без согласия партнёра");
    assert.equal(sql(`SELECT share_voice FROM match_participants WHERE match_id = '${id}' AND user_id = '${a.id}'`), "t");
    await b.send({ type: "voice_share", match_id: id, on: true });
    await a.waitFor(() => a.view.players.every((p) => p.share_voice), 10_000, "оба согласны");
    // До конца песни голос не принимается; чужой — не участник.
    assert.equal((await voice(a, "PUT", "", pcm(1))).status, 409);
    assert.equal((await voice(outsider, "GET", "/0")).status, 404);
    const version = await songVersion(A, song);
    for (const p of [a, b]) await p.send({ type: "ready", match_id: id, song_version: version, algorithm_version: 1 });
    for (const p of [a, b]) await p.waitFor(() => p.view?.start_at_ms != null, 10_000, "старт");
    const turns = a.view.turns;
    const slotA = a.view.players.find((p) => p.user_id === a.id).slot;
    const slotB = 1 - slotA;
    await Promise.all([
      a.sing(curve(song, 0).map((v, i) => (inTurns(turns, slotA, i) ? v : null))),
      b.sing(curve(song, 2).map((v, i) => (inTurns(turns, slotB, i) ? v : null))),
    ]);
    await a.state("finished", 40_000);
    // Запись длиннее песни не принимается; своя запись Ии — вся песня ненулевая, сервер оставляет её ходы.
    assert.equal((await voice(a, "PUT", "", pcm(17))).status, 413);
    assert.equal((await voice(b, "GET", `/${slotA}`)).status, 404, "голос ещё не загружен");
    assert.equal((await voice(a, "PUT", "", pcm(13.87))).status, 204);
    const got = await voice(b, "GET", `/${slotA}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    const samples = new Int16Array(await got.arrayBuffer());
    assert.equal(samples.length, Math.round(13.87 * 16000));
    for (let i = 0; i < samples.length; i += 400) {
      const own = turns.some((t) => t.slot === slotA && i / 16000 >= t.start_s && i / 16000 < t.end_s);
      assert.equal(samples[i], own ? 1000 : 0, `отсчёт ${i}: только ходы Ии`);
    }
    assert.equal((await voice(outsider, "GET", `/${slotA}`)).status, 404, "посторонний не получает голос");
    assert.equal((await voice(b, "PUT", "", pcm(13.87, -700))).status, 204);
    assert.equal((await voice(a, "GET", `/${slotB}`)).status, 200);
    assert.deepEqual(readdirSync(join(DATA, "coop", id)).sort(), ["0.pcm", "1.pcm"], "файлы матча в DATA_DIR/coop");
    // Выгрузка данных: режим и согласие поделиться голосом у матча; честно о том, где бывает голос.
    const exp = await (await fetch(`${A.base}/api/me/export`, { headers: { cookie: a.cookie } })).json();
    const row = exp.matches.find((m) => m.id === id);
    assert.equal(row.mode, "coop");
    assert.equal(row.share_voice, true);
    assert.match(exp.not_stored, /«Вместе»/);
    assert.match(exp.not_stored, /партн/);
    assert.ok(existsSync(join(DATA, "coop", id, `${slotA}.pcm`)));
    // Отправить можно только сразу после песни; забрать — пока матч свежий.
    sql(`UPDATE matches SET finished_at = now() - interval '2 minutes' WHERE id = '${id}'`);
    assert.equal((await voice(a, "PUT", "", pcm(13.87))).status, 410);
    assert.equal((await voice(b, "GET", `/${slotA}`)).status, 200);
    // Срок отправки прошёл, а голоса нет: он уже не придёт — 410, а не «ещё не загружен» (404),
    // чтобы страница партнёра перестала ждать и сказала, что запись не пришла.
    rmSync(join(DATA, "coop", id, `${slotB}.pcm`));
    const late = await voice(a, "GET", `/${slotB}`);
    assert.equal(late.status, 410, "после срока отправки отсутствующий голос не придёт");
    assert.match((await late.json()).error, /не отправили|удалена/);
    sql(`UPDATE matches SET finished_at = now() - interval '80 seconds' WHERE id = '${id}'`);
    assert.equal((await voice(a, "GET", `/${slotB}`)).status, 404, "в срок отправки голос ещё может прийти");
    sql(`UPDATE matches SET finished_at = now() - interval '9 minutes' WHERE id = '${id}'`);
    assert.equal((await voice(b, "GET", `/${slotA}`)).status, 410);
    // Отправки голоса ограничены на пользователя (30 в час): считаются все попытки, даже отказы.
    const tries = [];
    for (let k = 0; k < 31; k++) tries.push((await voice(outsider, "PUT", "", pcm(0.1))).status);
    assert.deepEqual([...new Set(tries.slice(0, 30))], [404]);
    assert.equal(tries[30], 429, "31-я отправка за час");
  });

  it("снять согласие можно всегда: во время песни и после неё; голоса тогда не принимаются и удаляются", async () => {
    const song = "cn-earth";
    const voice = (p, id, method, path, body) =>
      fetch(`${(p.instance ?? A).base}/api/matches/${id}/voice${path}`, {
        method,
        headers: { origin: ORIGIN, "x-perepev-request": "1", "content-type": "application/octet-stream", cookie: p.cookie },
        body,
      });
    const pcm = () => Buffer.from(new Int16Array(Math.round(13.87 * 16000)).fill(900).buffer);
    const shareBoth = async (a, b) => {
      await a.send({ type: "room_create", song_id: song, mode: "coop" });
      const room = a.events.findLast((e) => e.type === "room");
      await b.send({ type: "room_join", code: room.code });
      await a.waitFor(() => a.view?.room_code === room.code && a.view.state === "ready_check", 10_000, "готовность");
      const id = a.view.match_id;
      for (const p of [a, b]) await p.send({ type: "voice_share", match_id: id, on: true });
      await a.waitFor(() => a.view.players.every((p) => p.share_voice), 10_000, "оба согласны");
      const version = await songVersion(A, song);
      for (const p of [a, b]) await p.send({ type: "ready", match_id: id, song_version: version, algorithm_version: 1 });
      for (const p of [a, b]) await p.waitFor(() => p.view?.start_at_ms != null, 10_000, "старт");
      return id;
    };
    const sing = (a, b) => {
      const turns = a.view.turns;
      const slot = (p) => p.view.players.find((x) => x.user_id === p.id).slot;
      return Promise.all([a, b].map((p) => p.sing(curve(song, 0).map((v, i) => (inTurns(turns, slot(p), i) ? v : null)))));
    };

    // 1. Снял согласие уже после старта (как если бы галочку сняли в момент общего отсчёта).
    const a = await player("Мила", A);
    const b = await player("Ника", B);
    const id = await shareBoth(a, b);
    await b.send({ type: "voice_share", match_id: id, on: false });
    await a.waitFor(() => a.view.players.find((p) => p.user_id === b.id)?.share_voice === false, 10_000, "снятие видно партнёру");
    assert.equal(sql(`SELECT share_voice FROM match_participants WHERE match_id = '${id}' AND user_id = '${b.id}'`), "f");
    assert.ok(!b.events.some((e) => e.type === "error" && /до начала песни/.test(e.message)), "снятие не отклонено");
    // А дать согласие снова после старта нельзя: отказ приходит игроку, флаг не меняется.
    await b.send({ type: "voice_share", match_id: id, on: true });
    await b.waitFor(() => b.events.some((e) => e.type === "error" && /до начала песни/.test(e.message)), 10_000, "отказ");
    assert.equal(sql(`SELECT share_voice FROM match_participants WHERE match_id = '${id}' AND user_id = '${b.id}'`), "f");
    await sing(a, b);
    await a.state("finished", 40_000);
    assert.equal((await voice(a, id, "PUT", "", pcm())).status, 403, "без согласия обоих голос не принимается");

    // 2. Снял согласие после песни, когда голоса уже на сервере: флаг снят, файлы удалены.
    const c = await player("Олег", A);
    const d = await player("Пётр", B);
    const id2 = await shareBoth(c, d);
    await sing(c, d);
    await c.state("finished", 40_000);
    await d.state("finished", 40_000);
    for (const p of [c, d]) assert.equal((await voice(p, id2, "PUT", "", pcm())).status, 204);
    assert.ok(existsSync(join(DATA, "coop", id2)));
    await c.send({ type: "voice_share", match_id: id2, on: false });
    assert.equal(sql(`SELECT share_voice FROM match_participants WHERE match_id = '${id2}' AND user_id = '${c.id}'`), "f");
    assert.ok(!existsSync(join(DATA, "coop", id2)), "голоса матча удалены");
    assert.equal((await voice(d, id2, "GET", "/0")).status, 403);
    assert.equal((await voice(d, id2, "GET", "/1")).status, 403);
  });

  it("«Кто лучше» в комнате друга ведёт себя как прежде", async () => {
    const a = await player("Жанна", B);
    const b = await player("Захар", A);
    const song = "cn-earth";
    // Прежний клиент: room_create без режима.
    const { id, room } = await friendRoom(a, b, song);
    assert.equal(room.mode, "versus");
    assert.equal(a.view.mode, "versus");
    assert.equal(a.view.turns, undefined, "расписания нет");
    await Promise.all([a.sing(curve(song, -5)), b.sing(curve(song, 4, [[60, 160, 1.6]]))]);
    await a.state("finished", 40_000);
    await b.state("finished", 40_000);
    const res = a.view.result;
    assert.equal(res.team, undefined, "общего итога нет");
    assert.equal(res.players.find((p) => p.user_id === a.id).outcome, "win");
    assert.equal(res.players.find((p) => p.user_id === b.id).outcome, "loss");
    assert.equal(sql(`SELECT mode FROM matches WHERE id = '${id}'`), "versus");
    assert.equal(sql(`SELECT count(*) FROM rating_events WHERE match_id = '${id}'`), "0");
  });

  it("миграция 0007 повторяется без ошибок: путь вперёд после отката записи о ней", async () => {
    // Откат на прежнюю сборку: запись о миграции удаляется (OPERATIONS.md), столбцы остаются.
    A.stop();
    await new Promise((r) => setTimeout(r, 300));
    sql("DELETE FROM _sqlx_migrations WHERE version = 7");
    // Новая сборка снова применяет 0007 поверх уже существующих столбцов и ограничения.
    await A.start();
    assert.equal(sql("SELECT count(*) FROM _sqlx_migrations WHERE version = 7"), "1");
    assert.equal(sql("SELECT count(*) FROM pg_constraint WHERE conname = 'matches_coop_friend'"), "1");
    assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'match_participants' AND column_name = 'share_voice'"), "1");
  });
});
