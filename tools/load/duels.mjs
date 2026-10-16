// Нагрузочный прогон: N одновременных дуэлей (2N WebSocket-клиентов) на двух экземплярах.
// node tools/load/duels.mjs [N] — требует собранного API, PostgreSQL и Valkey (тестовые базы).
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Instance, Player, curve, resetStores, songVersion } from "../../tests/integration/lib.mjs";

const A = new Instance("load-a", 3201);
const B = new Instance("load-b", 3202);
// Регистрация через отдельный экземпляр: scrypt (128 МиБ на хеш) не искажает память A и B.
const R = new Instance("load-registrar", 3203);

const N = Number(process.argv[2] ?? 100);
const pct = (xs, p) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : NaN;
};
const rss = (inst) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(inst.proc.pid)], { encoding: "utf8" }).trim()) / 1024;
const cpu = (inst) => execFileSync("ps", ["-o", "time=", "-p", String(inst.proc.pid)], { encoding: "utf8" }).trim();

const dump = (e) => {
  console.error(String(e));
  console.error("alpha:", A.log.join("").slice(-3000));
  console.error("beta:", B.log.join("").slice(-3000));
  process.exit(1);
};
process.on("unhandledRejection", dump);
process.on("uncaughtException", dump);
resetStores();
await A.start();
await B.start();
await R.start();
const idle = { a: rss(A), b: rss(B) };

console.log(`Регистрация ${2 * N} игроков…`);
const players = [];
for (let i = 0; i < 2 * N; i += 2) {
  // Не больше двух вычислений scrypt одновременно на экземпляр.
  const batch = await Promise.all([0, 1].filter((k) => i + k < 2 * N).map((k) => new Player(`Нагрузка ${i + k}`).register(R)));
  players.push(...batch);
}
R.stop();
await Promise.all(players.map((p, i) => p.connect(i % 2 ? B : A)));
const connected = { a: rss(A), b: rss(B) };

// Метки для задержки показа соперника: время отправки точки → время получения у соперника.
const sentAt = new Map();
const display = [];
const acks = [];
for (const p of players) {
  const origSend = p.send.bind(p);
  p.send = (cmd) => {
    const t0 = performance.now();
    if (cmd.type === "perf") sentAt.set(`${cmd.match_id}:${p.id}:${cmd.from}`, t0);
    return origSend(cmd).then((r) => (acks.push(performance.now() - t0), r));
  };
  const origHandle = p.handle.bind(p);
  p.handle = (msg) => {
    if (msg.type === "opponent") {
      const other = p.view?.players.find((x) => x.user_id !== p.id)?.user_id;
      const t0 = sentAt.get(`${msg.match_id}:${other}:${msg.from}`);
      if (t0) display.push(performance.now() - t0);
    }
    origHandle(msg);
  };
}

console.log(`Создание ${N} комнат…`);
const version = { ode: await songVersion(A, "ode"), star: await songVersion(A, "star") };
const pairs = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const host = players[2 * i];
    const guest = players[2 * i + 1];
    const r = await host.send({ type: "room_create", song_id: i % 2 ? "star" : "ode" });
    if (!r.ok) throw new Error(r.error);
    const room = host.events.findLast((e) => e.type === "room");
    await guest.send({ type: "room_join", code: room.code });
    await Promise.all([host.state("ready_check", 30_000), guest.state("ready_check", 30_000)]);
    for (const p of [host, guest]) await p.send({ type: "ready", match_id: p.view.match_id, song_version: version[p.view.song.id], algorithm_version: 1 });
    await Promise.all([host, guest].map((p) => p.waitFor(() => p.view?.start_at_ms != null, 30_000, "старт")));
    return [host, guest];
  }),
);

console.log("Пение…");
let peak = { a: 0, b: 0 };
const sampler = setInterval(() => (peak = { a: Math.max(peak.a, rss(A)), b: Math.max(peak.b, rss(B)) }), 500);
const lagSamples = [];
let last = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  lagSamples.push(now - last - 50);
  last = now;
}, 50);
const resultLatency = [];
await Promise.all(
  players.map(async (p, i) => {
    await p.sing(curve(p.view.song.id, (i % 7) - 3, i % 3 ? [] : [[100, 160, 1.6]]));
    const end = p.view.start_at_ms + p.view.song.duration_s * 1000;
    await p.state("finished", 90_000);
    resultLatency.push(Date.now() - end);
  }),
);
clearInterval(sampler);
clearInterval(lagTimer);

const same = pairs.every(([h, g]) => JSON.stringify(h.view.result) === JSON.stringify(g.view.result));
const technical = players.filter((p) => p.view.result.technical).length;
const report = {
  duels: N,
  clients: 2 * N,
  all_finished: players.every((p) => p.view.state === "finished"),
  identical_results: same,
  technical_results: technical,
  ack_ms: { p50: pct(acks, 50), p95: pct(acks, 95), p99: pct(acks, 99), count: acks.length },
  opponent_display_ms: { p50: pct(display, 50), p95: pct(display, 95), p99: pct(display, 99), count: display.length },
  result_after_song_end_ms: { p50: pct(resultLatency, 50), p95: pct(resultLatency, 95), p99: pct(resultLatency, 99) },
  client_event_loop_lag_ms_p99: pct(lagSamples, 99),
  rss_mb: { idle, connected, peak },
  cpu_time: { a: cpu(A), b: cpu(B) },
};
console.log(JSON.stringify(report, null, 2));
for (const p of players) p.disconnect();
A.stop();
B.stop();
await sleep(200);
process.exit(report.all_finished && same ? 0 : 1);
