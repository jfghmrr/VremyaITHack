// Клиент WebSocket-протокола v1 (docs/protocol.md).
// Heartbeat каждые 5 с с оценкой смещения часов; переподключение с экспоненциальной
// задержкой и случайным разбросом; команды с номерами, подтверждения и повторная
// отправка неподтверждённых после переподключения; события матча — по seq без повторов.
import type { MatchView, QueueState, ServerEnvelope } from "#lib/api/types.ts";

type Command =
  | { type: "queue_join" }
  | { type: "queue_leave" }
  | { type: "room_create"; song_id: string }
  | { type: "room_join"; code: string }
  | { type: "accept"; match_id: string }
  | { type: "decline"; match_id: string }
  | { type: "ready"; match_id: string; song_version: string; algorithm_version: number }
  | { type: "perf"; match_id: string; from: number; points: (number | null)[] }
  | { type: "finish"; match_id: string; count: number }
  | { type: "leave"; match_id: string }
  | { type: "rematch"; match_id: string };

const MAX_PENDING = 600;

export const live = $state<{
  status: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  queue: QueueState | null;
  match: MatchView | null;
  room: { match_id: string; code: string } | null;
  opponent: (number | null)[];
  error: string;
  rtt: number | null;
  offset: number;
  pending: number;
}>({ status: "idle", queue: null, match: null, room: null, opponent: [], error: "", rtt: null, offset: 0, pending: 0 });

let socket: WebSocket | null = null;
let nextId = 1;
let lastSeq = 0;
let attempt = 0;
let heartbeat = 0;
let reconnectTimer = 0;
let wanted = false;
let samples: { rtt: number; offset: number }[] = [];
const pending = new Map<number, { cmd: Command; resolve: (ok: { ok: boolean; error?: string | null }) => void }>();

/** Время сервера по оценке с наименьшей задержкой из последних замеров, мс. */
export const serverNow = () => Date.now() + live.offset;

function send(raw: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, ...raw }));
}

function ping() {
  send({ id: 0, type: "ping", c: Date.now() });
}

export function connect() {
  wanted = true;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  live.status = attempt ? "reconnecting" : "connecting";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    live.status = "open";
    live.error = "";
    send({ id: 0, type: "hello", match_id: live.match?.match_id ?? null, last_seq: lastSeq });
    ping();
    // Повторная отправка неподтверждённых команд: сервер обрабатывает их идемпотентно.
    for (const [id, p] of pending) send({ id, ...p.cmd });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEnvelope);
  ws.onclose = (e) => {
    clearInterval(heartbeat);
    if (socket === ws) socket = null;
    if (!wanted) {
      live.status = "closed";
      return;
    }
    if (e.code === 1008 || e.reason === "session") {
      live.status = "closed";
      live.error = "Нужно войти в кабинет.";
      return;
    }
    live.status = "reconnecting";
    // Экспоненциальная задержка 0.5–10 с со случайным разбросом ±50%.
    const base = Math.min(10_000, 500 * 2 ** attempt++);
    reconnectTimer = window.setTimeout(connect, base * (0.5 + Math.random()));
  };
  ws.onerror = () => ws.close();
}

export function disconnect() {
  wanted = false;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  socket?.close();
  socket = null;
  live.status = "closed";
}

export function isTerminal(m: MatchView) {
  return m.state === "finished" || m.state === "cancelled" || m.state === "failed";
}

function handle(env: ServerEnvelope) {
  switch (env.type) {
    case "welcome":
      clearInterval(heartbeat);
      heartbeat = window.setInterval(ping, env.heartbeat_ms);
      break;
    case "pong": {
      const now = Date.now();
      const rtt = now - env.c;
      samples = [...samples.slice(-9), { rtt, offset: env.s - (env.c + rtt / 2) }];
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      live.rtt = best.rtt;
      live.offset = best.offset;
      break;
    }
    case "ack": {
      const p = pending.get(env.id);
      if (p) {
        pending.delete(env.id);
        live.pending = pending.size;
        p.resolve({ ok: env.ok, error: env.error });
        if (!env.ok && env.error) live.error = env.error;
      }
      break;
    }
    case "queue":
      live.queue = env.state;
      break;
    case "match":
      if (env.seq != null) {
        if (live.match?.match_id === env.view.match_id && env.seq <= lastSeq) break;
        lastSeq = env.seq;
      }
      if (live.match?.match_id !== env.view.match_id) {
        live.opponent = [];
        if (env.seq == null) lastSeq = 0;
      }
      live.match = env.view;
      break;
    case "opponent": {
      if (live.match?.match_id !== env.match_id) break;
      const next = live.opponent.slice();
      env.points.forEach((p, i) => (next[env.from + i] = p));
      live.opponent = next;
      break;
    }
    case "room":
      live.room = { match_id: env.match_id, code: env.code };
      break;
    case "error":
      live.error = env.message;
      break;
  }
}

/** Отправляет команду; результат — подтверждение сервера. Без соединения команда ждёт в очереди. */
export function command(cmd: Command): Promise<{ ok: boolean; error?: string | null }> {
  if (pending.size >= MAX_PENDING) return Promise.resolve({ ok: false, error: "Слишком много неотправленных данных." });
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { cmd, resolve });
    live.pending = pending.size;
    send({ id, ...cmd });
  });
}

export function resetMatch() {
  live.match = null;
  live.opponent = [];
  live.room = null;
  lastSeq = 0;
}
