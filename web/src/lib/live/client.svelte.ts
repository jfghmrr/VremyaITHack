// Клиент WebSocket-протокола v1 (docs/protocol.md).
// Heartbeat каждые 5 с с оценкой смещения часов; переподключение с экспоненциальной
// задержкой и случайным разбросом; команды с номерами, подтверждения и повторная
// отправка неподтверждённых после переподключения; события матча — по seq без повторов.
//
// Фон и сон (2026-10-17). В фоновой вкладке браузер замедляет таймеры (Chrome через 5 минут —
// до раза в минуту; телефон и вовсе останавливает страницу), пинги не уходят, и сервер закрывает
// соединение после 15 с тишины. Повторы в фоне тоже не проходят, задержка дорастала до 10 ± 5 с,
// и, вернувшись во вкладку, игрок видел «Восстанавливаем соединение…» с выключенными кнопками.
// Теперь при возврате во вкладку, появлении сети и показе страницы из кеша соединение
// восстанавливается сразу; молчащее соединение (сервер не ответил на два пинга подряд при
// открытой вкладке) закрывается и открывается заново; плашка «нет связи» (`lost`) появляется,
// только если связи нет дольше LOST_MS, — короткий штатный переподключение её не показывает.
//
// Поиск соперника (2026-10-17). Заявка в очереди живёт 30 с после последнего heartbeat: если
// страница спала дольше (телефон в кармане, вкладка в фоне), сервер её снимает, и после
// переподключения поиск молча заканчивался. Теперь клиент помнит, что игрок ищет и не отменял
// поиск, и при пустой очереди в ответе на hello начинает поиск заново (если связи не было не
// дольше RESUME_MS), а иначе показывает, почему поиск остановлен.
import type { MatchView, QueueState, ServerEnvelope } from "#lib/api/types.ts";

/** Режим комнаты друга: «Кто лучше» (дуэль) или «Вместе» (по очереди, общий балл). */
export type MatchMode = "versus" | "coop";

type Command =
  | { type: "queue_join" }
  | { type: "queue_leave" }
  | { type: "room_create"; song_id: string; mode?: MatchMode }
  | { type: "room_join"; code: string }
  | { type: "accept"; match_id: string }
  | { type: "decline"; match_id: string }
  | { type: "ready"; match_id: string; song_version: string; algorithm_version: number }
  | { type: "perf"; match_id: string; from: number; points: (number | null)[] }
  | { type: "finish"; match_id: string; count: number }
  | { type: "leave"; match_id: string }
  | { type: "rematch"; match_id: string }
  | { type: "voice_share"; match_id: string; on: boolean };

const MAX_PENDING = 600;
/** Сколько связь должна отсутствовать, чтобы показать плашку «нет связи», мс. */
const LOST_MS = 2500;

/** Сколько может не быть связи, чтобы поиск соперника продолжился сам, мс. */
export const RESUME_MS = 3 * 60_000;
/**
 * Сколько может пройти с последнего действия игрока на странице (нажатие, клавиша, касание) или с
 * начатого им поиска, чтобы поиск продолжился сам: забытая фоновая вкладка не ищет бесконечно.
 */
export const RESUME_IDLE_MS = 10 * 60_000;
export const SEARCH_STOPPED = "Поиск остановлен: связи с сервером не было дольше трёх минут. Нажми «Найти соперника», чтобы искать снова.";
export const SEARCH_IDLE = "Поиск остановлен: на странице давно ничего не нажимали. Нажми «Найти соперника», чтобы искать снова.";

/** Срок жизни комнаты на сервере (ROOM_SECONDS, 15 минут): позже приглашение уже не принять. */
export const ROOM_MS = 15 * 60_000;

/**
 * Комната: своя (создал игрок или его реванш) или приглашение соперника на реванш.
 * `at` — когда пришло сообщение (Date.now()); `rival` и `song` — имя соперника и песня прошлого
 * матча, если он был на экране, когда пришло приглашение (иначе их на клиенте нет).
 */
export type Room = { match_id: string; code: string; rematch_of: string | null; invite: boolean; at: number; rival: string | null; song: string | null; mode: MatchMode };

export const live = $state<{
  status: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  /** Связи нет дольше LOST_MS: показать понятное сообщение. */
  lost: boolean;
  /** Браузер сообщает, что сети нет. */
  offline: boolean;
  queue: QueueState | null;
  match: MatchView | null;
  room: Room | null;
  opponent: (number | null)[];
  error: string;
  rtt: number | null;
  offset: number;
  pending: number;
  /** Заявка пропала, пока не было связи, и поиск начат заново. */
  resumed: boolean;
}>({ status: "idle", lost: false, offline: false, queue: null, match: null, room: null, opponent: [], error: "", rtt: null, offset: 0, pending: 0, resumed: false });

let socket: WebSocket | null = null;
let nextId = 1;
let lastSeq = 0;
let attempt = 0;
let heartbeat = 0;
let reconnectTimer = 0;
let wanted = false;
let samples: { rtt: number; offset: number }[] = [];
let heartbeatMs = 5000;
let heardAt = 0;
let lostTimer = 0;
let watching = false;
/**
 * Идёт переподключение (а не первое подключение). Обычная переменная, а не чтение live.status:
 * connect() вызывают из $effect страниц дуэлей, и чтение состояния подписало бы эффект на статус.
 */
let retrying = false;
/** user_id из welcome: соперник в прошлом матче — второй игрок. */
let me = "";
/** Игрок ищет соперника и не отменял поиск (последнее состояние очереди — «ищем»). */
let searchWanted = false;
/** Следующее состояние очереди — ответ на hello после (пере)подключения. */
let helloReply = false;
/**
 * Когда связь точно была: время отправки последнего пинга, на который пришёл ответ. Время обработки
 * сообщения не годится: уснувшая страница обрабатывает накопленные сообщения только при пробуждении.
 */
let aliveAt = 0;
/** aliveAt до текущего подключения. */
let aliveBefore = 0;
/** Последнее действие игрока на странице или начатый им поиск. */
let touchedAt = 0;
/** Заявку шлёт сам клиент (продолжение поиска), а не игрок. */
let resuming = false;
const pending = new Map<number, { cmd: Command; resolve: (ok: { ok: boolean; error?: string | null }) => void }>();

/** Время сервера по оценке с наименьшей задержкой из последних замеров, мс. */
export const serverNow = () => Date.now() + live.offset;

function send(raw: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, ...raw }));
}

function ping() {
  // Сервер не ответил на два пинга подряд при открытой вкладке: соединение полуоткрыто
  // (например, после сна ноутбука). Закрываем его — onclose переподключит.
  if (socket?.readyState === WebSocket.OPEN && !document.hidden && Date.now() - heardAt > heartbeatMs * 2.5) {
    // Закрытие мёртвого соединения может ждать ответа сервера десятки секунд: не ждём его,
    // а сразу открываем новое (событие close старого сокета игнорируется).
    const dead = socket;
    socket = null;
    clearInterval(heartbeat);
    dead.onclose = null;
    dead.close();
    scheduleReconnect();
    return;
  }
  send({ id: 0, type: "ping", c: Date.now() });
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = window.setInterval(ping, heartbeatMs);
}

function scheduleReconnect() {
  if (live.status !== "reconnecting") {
    clearTimeout(lostTimer);
    lostTimer = window.setTimeout(() => (live.lost = live.status !== "open"), LOST_MS);
  }
  live.status = "reconnecting";
  retrying = true;
  // Экспоненциальная задержка 0.5–10 с со случайным разбросом ±50%.
  const base = Math.min(10_000, 500 * 2 ** attempt++);
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, base * (0.5 + Math.random()));
}

/** Возврат во вкладку, появление сети, показ страницы из кеша: связь проверяется сразу. */
function wake() {
  live.offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!wanted || document.hidden) return;
  if (!socket || socket.readyState >= WebSocket.CLOSING) reconnectNow();
  else if (socket.readyState === WebSocket.OPEN) ping();
}

const touch = () => (touchedAt = Date.now());

function watch() {
  if (watching || typeof window === "undefined" || typeof document === "undefined") return;
  watching = true;
  touch();
  for (const type of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(type, touch, { capture: true, passive: true });
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  window.addEventListener("pageshow", wake);
  window.addEventListener("focus", wake);
}

/** Переподключиться без ожидания задержки повтора (кнопка «Переподключить» и события браузера). */
export function reconnectNow() {
  if (!wanted) return;
  clearTimeout(reconnectTimer);
  attempt = 0;
  connect();
}

export function connect() {
  wanted = true;
  watch();
  live.offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  live.status = attempt || retrying ? "reconnecting" : "connecting";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    aliveBefore = aliveAt;
    heardAt = Date.now();
    helloReply = true;
    clearTimeout(lostTimer);
    live.lost = false;
    live.status = "open";
    retrying = false;
    live.error = "";
    send({ id: 0, type: "hello", match_id: live.match?.match_id ?? null, last_seq: lastSeq });
    ping();
    startHeartbeat();
    // Повторная отправка неподтверждённых команд: сервер обрабатывает их идемпотентно.
    for (const [id, p] of pending) send({ id, ...p.cmd });
  };
  ws.onmessage = (e) => {
    heardAt = Date.now();
    handle(JSON.parse(e.data) as ServerEnvelope);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    clearInterval(heartbeat);
    socket = null;
    if (!wanted) {
      live.status = "closed";
      return;
    }
    if (e.code === 1008 || e.reason === "session") {
      live.status = "closed";
      retrying = false;
      live.error = "Нужно войти в кабинет.";
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

export function disconnect() {
  wanted = false;
  clearTimeout(reconnectTimer);
  clearTimeout(lostTimer);
  clearInterval(heartbeat);
  socket?.close();
  socket = null;
  live.status = "closed";
  retrying = false;
  live.lost = false;
}

export function isTerminal(m: MatchView) {
  return m.state === "finished" || m.state === "cancelled" || m.state === "failed";
}

function handle(env: ServerEnvelope) {
  switch (env.type) {
    case "welcome":
      // Другой аккаунт в том же окне (выход и вход): поиск прежнего игрока не продолжается.
      if (me && env.user_id !== me) resetSearch();
      me = env.user_id;
      heartbeatMs = env.heartbeat_ms;
      startHeartbeat();
      break;
    case "pong": {
      const now = Date.now();
      const rtt = now - env.c;
      aliveAt = Math.max(aliveAt, env.c);
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
    case "queue": {
      const reply = helloReply;
      helloReply = false;
      // Заявка пропала, пока не было связи: сервер снимает её через 30 с без heartbeat.
      if (reply && env.state.status === "idle" && searchWanted && !activeMatch() && !queued("queue_leave")) {
        searchWanted = false;
        live.resumed = false;
        const now = Date.now();
        // Игрок как раз входит в комнату друга: рейтинговый поиск ему больше не нужен.
        if (queued("room_create") || queued("room_join") || queued("rematch")) live.queue = env.state;
        else if (now - aliveBefore > RESUME_MS) live.queue = { ...env.state, note: SEARCH_STOPPED };
        else if (now - touchedAt > RESUME_IDLE_MS) live.queue = { ...env.state, note: SEARCH_IDLE };
        else resume(env.state);
        break;
      }
      searchWanted = env.state.status === "searching";
      if (!searchWanted) live.resumed = false;
      live.queue = env.state;
      break;
    }
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
      // Пропуск до первой точки пакета — пауза, а не дыра массива: у «Вместе» сервер не шлёт
      // чужие ходы партнёра (они заранее пауза), а график и прослушивание читают каждую точку.
      for (let k = next.length; k < env.from; k++) next[k] = null;
      env.points.forEach((p, i) => (next[env.from + i] = p));
      live.opponent = next;
      break;
    }
    case "room": {
      const prev = env.rematch_of && live.match?.match_id === env.rematch_of ? live.match : null;
      live.room = {
        match_id: env.match_id,
        code: env.code,
        rematch_of: env.rematch_of ?? null,
        invite: env.invite === true,
        at: Date.now(),
        rival: prev?.players.find((p) => p.user_id !== me)?.name ?? null,
        song: prev?.song.title ?? null,
        mode: env.mode === "coop" ? "coop" : "versus",
      };
      break;
    }
    case "error":
      live.error = env.message;
      break;
  }
}

/** Поиск продолжается сам. Пока сервер не ответил, на экране не «ищем»: заявки сейчас нет. */
function resume(idle: QueueState) {
  live.resumed = true;
  live.queue = idle;
  if (queued("queue_join")) return;
  resuming = true;
  void command({ type: "queue_join" }).then((r) => {
    if (r.ok) return;
    // Не получилось (например, игрок уже в другом матче): поиск остановлен, причина — в очереди.
    searchWanted = false;
    live.resumed = false;
    if (live.error === r.error) live.error = "";
    live.queue = { ...idle, note: `Поиск не продолжился. ${r.error ?? ""}`.trim() };
  });
  resuming = false;
}

/** Смена аккаунта (выход из кабинета, вход другим): поиск прежнего игрока сбрасывается, его
 *  неотправленные заявки и отмены не уходят от имени нового. */
export function resetSearch() {
  searchWanted = false;
  live.resumed = false;
  live.queue = null;
  aliveAt = 0;
  aliveBefore = 0;
  for (const [id, p] of pending) {
    if (p.cmd.type === "queue_join" || p.cmd.type === "queue_leave") {
      pending.delete(id);
      p.resolve({ ok: false, error: null });
    }
  }
  live.pending = pending.size;
}

function activeMatch() {
  return !!live.match && !isTerminal(live.match);
}

/** Команда этого типа ждёт подтверждения (уйдёт повторно после переподключения). */
function queued(type: Command["type"]) {
  for (const p of pending.values()) if (p.cmd.type === type) return true;
  return false;
}

/** Отправляет команду; результат — подтверждение сервера. Без соединения команда ждёт в очереди. */
export function command(cmd: Command): Promise<{ ok: boolean; error?: string | null }> {
  if (pending.size >= MAX_PENDING) return Promise.resolve({ ok: false, error: "Слишком много неотправленных данных." });
  const id = nextId++;
  if (cmd.type === "queue_join" && !resuming) touch();
  return new Promise((resolve) => {
    pending.set(id, { cmd, resolve });
    live.pending = pending.size;
    send({ id, ...cmd });
  });
}

/**
 * Приглашение соперника на реванш, которое ещё можно принять: комната ждёт не дольше ROOM_MS.
 * `now` передаёт страница со своими часами, чтобы приглашение скрылось вовремя.
 */
export function activeInvite(now: number): Room | null {
  const r = live.room;
  return r?.invite && now - r.at < ROOM_MS ? r : null;
}

/**
 * Уход с экрана матча. Состояние очереди «соперник найден» (с номером уже сыгранного матча)
 * тоже сбрасывается: иначе «Дуэли» сразу уводили обратно на итог. Идущий поиск и
 * приглашение соперника на реванш остаются.
 */
export function resetMatch() {
  live.match = null;
  live.opponent = [];
  if (!live.room?.invite) live.room = null;
  if (live.queue?.status !== "searching") live.queue = null;
  lastSeq = 0;
}
