// Клиент WebSocket дуэлей: переподключение после фона и полуоткрытого соединения,
// плашка «нет связи» без мигания, очистка состояния после матча, приглашение на реванш.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

type Listener = () => void;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.closedByClient = true;
    this.drop();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Сервер или сеть закрыли соединение. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...msg }) });
  }
}

const docListeners = new Map<string, Listener[]>();
const winListeners = new Map<string, Listener[]>();
const doc = {
  visibilityState: "visible" as "visible" | "hidden",
  get hidden() {
    return this.visibilityState === "hidden";
  },
  addEventListener: (type: string, fn: Listener) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
};
const nav = { onLine: true };
const fire = (map: Map<string, Listener[]>, type: string) => map.get(type)?.forEach((fn) => fn());

async function client() {
  vi.resetModules();
  return import("../src/lib/live/client.svelte.ts");
}

// Первая сборка модуля Svelte медленная: прогрев вне тестов с таймаутом.
beforeAll(async () => {
  await import("../src/lib/live/client.svelte.ts");
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  docListeners.clear();
  winListeners.clear();
  doc.visibilityState = "visible";
  nav.onLine = true;
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("location", { protocol: "https:", host: "perepev.test" });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: (type: string, fn: Listener) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const last = () => FakeSocket.all.at(-1)!;
const welcome = (s: FakeSocket) => s.receive({ type: "welcome", user_id: "u", name: "n", server_time: Date.now(), heartbeat_ms: 5000 });

it("вкладка вернулась из фона, пока ждали повтора подключения: соединение восстанавливается сразу", async () => {
  const { connect, live } = await client();
  connect();
  last().open();
  welcome(last());
  // В фоне таймеры замедлены: пинги не уходят, сервер закрывает соединение по тишине,
  // повторы не проходят (сеть на телефоне засыпает), задержка дорастает до 10 ± 5 с.
  doc.visibilityState = "hidden";
  fire(docListeners, "visibilitychange");
  last().drop();
  for (let k = 0; k < 5; k++) {
    await vi.advanceTimersToNextTimerAsync();
    last().drop();
  }
  expect(live.status).toBe("reconnecting");
  const before = FakeSocket.all.length;
  doc.visibilityState = "visible";
  fire(docListeners, "visibilitychange");
  expect(FakeSocket.all.length, "новое соединение без ожидания таймера").toBe(before + 1);
  last().open();
  expect(live.status).toBe("open");
});

it("сеть вернулась (online): переподключение сразу", async () => {
  const { connect } = await client();
  connect();
  last().open();
  last().drop();
  for (let k = 0; k < 4; k++) {
    await vi.advanceTimersToNextTimerAsync();
    last().drop();
  }
  const before = FakeSocket.all.length;
  fire(winListeners, "online");
  expect(FakeSocket.all.length).toBe(before + 1);
});

it("полуоткрытое соединение: без ответа сервера 15 с при открытой вкладке клиент переподключается", async () => {
  const { connect } = await client();
  connect();
  const first = last();
  first.open();
  welcome(first);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(first.closedByClient, "молчащее соединение закрыто клиентом").toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(FakeSocket.all.length).toBeGreaterThan(1);
});

it("пока сервер отвечает на пинги, соединение не трогается", async () => {
  const { connect } = await client();
  connect();
  const first = last();
  first.open();
  welcome(first);
  for (let k = 0; k < 10; k++) {
    await vi.advanceTimersByTimeAsync(5_000);
    first.receive({ type: "pong", c: Date.now() - 20, s: Date.now() });
  }
  expect(first.closedByClient).toBe(false);
  expect(FakeSocket.all.length).toBe(1);
});

it("короткий разрыв не поднимает плашку «нет связи», долгий — поднимает", async () => {
  const { connect, live } = await client();
  connect();
  last().open();
  last().drop();
  expect(live.status).toBe("reconnecting");
  expect(live.lost).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  last().open();
  expect(live.lost).toBe(false);
  last().drop();
  await vi.advanceTimersByTimeAsync(1_000);
  last().drop();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(live.lost).toBe(true);
  fire(winListeners, "online");
  last().open();
  expect(live.lost).toBe(false);
});

it("после матча сброс убирает «найденный» матч очереди и свою комнату, приглашение на реванш остаётся", async () => {
  const { connect, live, resetMatch } = await client();
  connect();
  const s = last();
  s.open();
  welcome(s);
  s.receive({ type: "queue", state: { status: "matched", pool: null, window: null, since_ms: null, match_id: "m1", note: null } });
  s.receive({ type: "room", match_id: "r1", code: "ABCDEF" });
  expect(live.room).toMatchObject({ match_id: "r1", code: "ABCDEF", rematch_of: null, invite: false });
  resetMatch();
  expect(live.queue, "очередь не уводит обратно на итог матча").toBeNull();
  expect(live.room).toBeNull();
  s.receive({ type: "room", match_id: "r2", code: "GHJKLM", rematch_of: "m1", invite: true });
  resetMatch();
  expect(live.room).toMatchObject({ match_id: "r2", code: "GHJKLM", rematch_of: "m1", invite: true });
  // Идущий поиск сброс не трогает.
  s.receive({ type: "queue", state: { status: "searching", pool: "cal", window: 80, since_ms: 1, match_id: null, note: null } });
  resetMatch();
  expect(live.queue?.status).toBe("searching");
});

it("приглашение на реванш живёт 15 минут (срок комнаты) и называет соперника и песню прошлого матча", async () => {
  const { activeInvite, connect, live, resetMatch, ROOM_MS } = await client();
  connect();
  const s = last();
  s.open();
  welcome(s);
  // Итог прошлого матча на экране: имя соперника и песня известны клиенту.
  s.receive({ type: "match", view: { match_id: "m1", state: "finished", kind: "rated", song: { id: "cn-earth", title: "Земля" }, players: [{ user_id: "u", name: "Аня" }, { user_id: "r", name: "Борис" }] } });
  const t0 = Date.now();
  s.receive({ type: "room", match_id: "r2", code: "GHJKLM", rematch_of: "m1", invite: true });
  expect(activeInvite(t0)).toMatchObject({ code: "GHJKLM", rival: "Борис", song: "Земля" });
  expect(activeInvite(t0 + ROOM_MS - 1000), "комната ещё ждёт").not.toBeNull();
  expect(activeInvite(t0 + ROOM_MS), "комната закрыта по сроку — приглашение не показывается").toBeNull();
  // Без прошлого матча на экране имени и песни нет: страница пишет «Соперник» и «та же песня».
  resetMatch();
  s.receive({ type: "room", match_id: "r3", code: "PQRSTU", rematch_of: "m9", invite: true });
  expect(activeInvite(Date.now())).toMatchObject({ code: "PQRSTU", rival: null, song: null });
  // Своя комната — не приглашение.
  s.receive({ type: "room", match_id: "r4", code: "VWXYZA" });
  expect(activeInvite(Date.now())).toBeNull();
  expect(live.room?.invite).toBe(false);
});

it("«Вместе»: точки партнёра без пропусков в массиве, приглашение называет режим", async () => {
  const { connect, live } = await client();
  connect();
  const s = last();
  s.open();
  welcome(s);
  s.receive({ type: "match", seq: 1, view: { match_id: "m1", state: "singing", kind: "friend", mode: "coop", song: { id: "cn-earth", title: "Земля" }, players: [] } });
  // Сервер не шлёт чужие ходы партнёра (они заранее пауза): первые точки приходят с середины.
  s.receive({ type: "opponent", match_id: "m1", from: 30, points: [612, 615] });
  expect(live.opponent).toHaveLength(32);
  // Дыр нет: пропущенное — пауза, график и прослушивание читают каждую точку.
  expect(Object.keys(live.opponent)).toHaveLength(32);
  expect(live.opponent.slice(0, 30).every((p) => p === null)).toBe(true);
  expect(live.opponent.slice(30)).toEqual([612, 615]);
  // Повтор и более ранние точки пишутся по индексу.
  s.receive({ type: "opponent", match_id: "m1", from: 10, points: [600] });
  expect(live.opponent[10]).toBe(600);
  expect(live.opponent).toHaveLength(32);
  s.receive({ type: "room", match_id: "r2", code: "GHJKLM", rematch_of: "m1", invite: true, mode: "coop" });
  expect(live.room?.mode).toBe("coop");
  s.receive({ type: "room", match_id: "r3", code: "PQRSTU" });
  expect(live.room?.mode, "прежний сервер без режима — «Кто лучше»").toBe("versus");
});


const searching = (since = 1) => ({ status: "searching", pool: "cal", window: 80, since_ms: since, match_id: null, note: null });
const idle = { status: "idle", pool: null, window: null, since_ms: null, match_id: null, note: null };
const joins = (s: FakeSocket) => s.sent.filter((m) => m.type === "queue_join").length;
/** Сервер отвечает на пинги этого соединения: время отправки пинга возвращается в pong. */
const pongs = (s: FakeSocket) => {
  for (const m of s.sent) if (m.type === "ping") s.receive({ type: "pong", c: m.c, s: Date.now() });
};

it("заявка пропала, пока не было связи (вкладка спала дольше 30 с): поиск продолжается сам", async () => {
  const { command, connect, live } = await client();
  connect();
  const first = last();
  first.open();
  welcome(first);
  void command({ type: "queue_join" });
  first.receive({ type: "ack", id: 1, ok: true });
  first.receive({ type: "queue", state: searching() });
  pongs(first);
  // Страница спит 40 с: сервер закрыл соединение по тишине и снял заявку через 30 с.
  doc.visibilityState = "hidden";
  fire(docListeners, "visibilitychange");
  first.drop();
  await vi.advanceTimersByTimeAsync(40_000);
  doc.visibilityState = "visible";
  fire(docListeners, "visibilitychange");
  const second = last();
  second.open();
  welcome(second);
  second.receive({ type: "queue", state: idle });
  expect(joins(second), "поиск начат заново").toBe(1);
  // Пока сервер не принял новую заявку, экран не показывает «ищем»: заявки сейчас нет.
  expect(live.queue?.status).toBe("idle");
  expect(live.resumed).toBe(true);
  second.receive({ type: "queue", state: searching(2) });
  expect(live.queue?.status).toBe("searching");
  expect(live.queue?.since_ms).toBe(2);
  expect(live.resumed, "строка «поиск начат заново» видна во время поиска").toBe(true);
});

it("после переподключения заявка цела — второй заявки клиент не шлёт", async () => {
  const { command, connect, live } = await client();
  connect();
  const first = last();
  first.open();
  welcome(first);
  void command({ type: "queue_join" });
  first.receive({ type: "ack", id: 1, ok: true });
  first.receive({ type: "queue", state: searching() });
  pongs(first);
  first.drop();
  await vi.advanceTimersByTimeAsync(2_000);
  const second = last();
  second.open();
  welcome(second);
  second.receive({ type: "queue", state: searching() });
  expect(joins(second)).toBe(0);
  expect(live.resumed).toBe(false);
});

it("отменённый поиск, найденный за время разрыва матч и долгий разрыв поиск не возобновляют", async () => {
  const { command, connect, live, SEARCH_STOPPED } = await client();
  connect();
  let s = last();
  s.open();
  welcome(s);
  // 1. Игрок отменил поиск: пустая очередь после переподключения — это его выбор.
  s.receive({ type: "queue", state: searching() });
  void command({ type: "queue_leave" });
  s.receive({ type: "ack", id: 1, ok: true });
  s.receive({ type: "queue", state: idle });
  s.drop();
  await vi.advanceTimersByTimeAsync(2_000);
  s = last();
  s.open();
  s.receive({ type: "queue", state: idle });
  expect(joins(s)).toBe(0);
  // 2. За время разрыва нашёлся матч: сервер присылает его раньше очереди.
  s.receive({ type: "queue", state: searching() });
  pongs(s);
  s.drop();
  await vi.advanceTimersByTimeAsync(2_000);
  s = last();
  s.open();
  s.receive({ type: "match", seq: 1, view: { match_id: "m1", state: "waiting", kind: "rated", players: [] } });
  s.receive({ type: "queue", state: idle });
  expect(joins(s), "игрок уже в матче").toBe(0);
  // 3. Связи не было дольше трёх минут: поиск не продолжается сам, а игрок видит почему.
  s.receive({ type: "match", seq: 2, view: { match_id: "m1", state: "cancelled", kind: "rated", players: [] } });
  s.receive({ type: "queue", state: searching() });
  pongs(s);
  doc.visibilityState = "hidden";
  fire(docListeners, "visibilitychange");
  s.drop();
  await vi.advanceTimersByTimeAsync(200_000);
  doc.visibilityState = "visible";
  fire(docListeners, "visibilitychange");
  s = last();
  s.open();
  s.receive({ type: "queue", state: idle });
  expect(joins(s)).toBe(0);
  expect(live.queue?.status).toBe("idle");
  expect(live.queue?.note).toBe(SEARCH_STOPPED);
});

it("уснувшая страница обрабатывает старые сообщения при пробуждении: разрыв считается по последнему ответу на пинг", async () => {
  const { command, connect, live, SEARCH_STOPPED } = await client();
  connect();
  const s = last();
  s.open();
  welcome(s);
  void command({ type: "queue_join" });
  s.receive({ type: "ack", id: 1, ok: true });
  s.receive({ type: "queue", state: searching() });
  pongs(s);
  // Телефон спит 5 минут. Пояснение подбора, пришедшее во сне, обрабатывается только при пробуждении.
  doc.visibilityState = "hidden";
  fire(docListeners, "visibilitychange");
  await vi.advanceTimersByTimeAsync(300_000);
  s.receive({ type: "queue", state: { ...searching(), note: "Сейчас больше никто не ищет соперника." } });
  s.drop();
  doc.visibilityState = "visible";
  fire(docListeners, "visibilitychange");
  const next = last();
  next.open();
  next.receive({ type: "queue", state: idle });
  expect(joins(next), "связи не было 5 минут — поиск сам не продолжается").toBe(0);
  expect(live.queue?.note).toBe(SEARCH_STOPPED);
});

/** Сервер отвечает только на новые пинги соединения. */
const answered = new WeakMap<FakeSocket, number>();
const pongsNew = (s: FakeSocket) => {
  const from = answered.get(s) ?? 0;
  s.sent.slice(from).forEach((m) => m.type === "ping" && s.receive({ type: "pong", c: m.c, s: Date.now() }));
  answered.set(s, s.sent.length);
};
/** Поиск идёт, затем соединение рвётся, и через `gap` мс клиент переподключается. */
async function searchingThenReconnect(api: Awaited<ReturnType<typeof client>>, gap = 40_000) {
  api.connect();
  const first = last();
  first.open();
  welcome(first);
  void api.command({ type: "queue_join" });
  first.receive({ type: "ack", id: 1, ok: true });
  first.receive({ type: "queue", state: searching() });
  pongs(first);
  first.drop();
  await vi.advanceTimersByTimeAsync(gap);
  fire(winListeners, "online");
  const next = last();
  next.open();
  return next;
}

it("выход и вход другим аккаунтом: поиск прежнего игрока не продолжается от имени нового", async () => {
  const api = await client();
  const next = await searchingThenReconnect(api);
  next.receive({ type: "welcome", user_id: "other", name: "Б", server_time: Date.now(), heartbeat_ms: 5000 });
  next.receive({ type: "queue", state: idle });
  expect(joins(next), "другой аккаунт").toBe(0);
  expect(api.live.resumed).toBe(false);
});

it("выход из кабинета сбрасывает поиск: после входа тем же или другим аккаунтом он не продолжается сам", async () => {
  const api = await client();
  api.connect();
  const first = last();
  first.open();
  welcome(first);
  void api.command({ type: "queue_join" });
  first.receive({ type: "ack", id: 1, ok: true });
  first.receive({ type: "queue", state: searching() });
  pongs(first);
  first.drop();
  // Пока связи нет, игрок ещё раз нажал «Найти соперника» и вышел из кабинета.
  void api.command({ type: "queue_join" });
  api.resetSearch();
  expect(api.live.queue).toBeNull();
  fire(winListeners, "online");
  const next = last();
  next.open();
  welcome(next);
  next.receive({ type: "queue", state: idle });
  expect(joins(next), "ни возобновления, ни неотправленной заявки прежнего игрока").toBe(0);
});

it("игрок входит в комнату во время переподключения: поиск не возобновляется", async () => {
  const api = await client();
  api.connect();
  const first = last();
  first.open();
  welcome(first);
  void api.command({ type: "queue_join" });
  first.receive({ type: "ack", id: 1, ok: true });
  first.receive({ type: "queue", state: searching() });
  pongs(first);
  first.drop();
  await vi.advanceTimersByTimeAsync(40_000);
  void api.command({ type: "room_join", code: "ABCDEF" });
  fire(winListeners, "online");
  const next = last();
  next.open();
  welcome(next);
  next.receive({ type: "queue", state: idle });
  expect(joins(next)).toBe(0);
  expect(api.live.queue?.status).toBe("idle");
  expect(api.live.resumed).toBe(false);
});

it("продолжить поиск не удалось: экран не крутит мёртвый поиск, флаг возобновления снят", async () => {
  const api = await client();
  const next = await searchingThenReconnect(api);
  welcome(next);
  next.receive({ type: "queue", state: idle });
  expect(joins(next)).toBe(1);
  expect(api.live.queue?.status, "пока поиск возобновляется — не «ищем»").toBe("idle");
  const join = next.sent.find((m) => m.type === "queue_join")!;
  next.receive({ type: "ack", id: join.id, ok: false, error: "Ты уже в другом матче. Заверши его, чтобы начать новый." });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.live.queue?.status).toBe("idle");
  expect(api.live.queue?.note).toMatch(/уже в другом матче/);
  expect(api.live.resumed).toBe(false);
  // Следующее переподключение поиск уже не возобновляет.
  next.drop();
  await vi.advanceTimersByTimeAsync(2_000);
  const third = last();
  third.open();
  third.receive({ type: "queue", state: idle });
  expect(joins(third)).toBe(0);
});

it("больше 10 минут без действий игрока: поиск сам не возобновляется", async () => {
  const api = await client();
  api.connect();
  const s = last();
  s.open();
  welcome(s);
  void api.command({ type: "queue_join" });
  s.receive({ type: "ack", id: 1, ok: true });
  s.receive({ type: "queue", state: searching() });
  // Вкладка в фоне 11 минут: соединение живо, сервер отвечает на пинги, но игрок ничего не нажимает.
  for (let k = 0; k < 132; k++) {
    await vi.advanceTimersByTimeAsync(5_000);
    pongsNew(s);
  }
  s.drop();
  await vi.advanceTimersByTimeAsync(1_000);
  const next = last();
  next.open();
  welcome(next);
  next.receive({ type: "queue", state: idle });
  expect(joins(next)).toBe(0);
  expect(api.live.queue?.note).toBe(api.SEARCH_IDLE);
});

it("игрок недавно нажимал на странице: поиск возобновляется и после долгого поиска в фоне", async () => {
  const api = await client();
  api.connect();
  const s = last();
  s.open();
  welcome(s);
  void api.command({ type: "queue_join" });
  s.receive({ type: "ack", id: 1, ok: true });
  s.receive({ type: "queue", state: searching() });
  for (let k = 0; k < 132; k++) {
    await vi.advanceTimersByTimeAsync(5_000);
    pongsNew(s);
    if (k === 100) fire(winListeners, "pointerdown");
  }
  s.drop();
  await vi.advanceTimersByTimeAsync(1_000);
  const next = last();
  next.open();
  welcome(next);
  next.receive({ type: "queue", state: idle });
  expect(joins(next)).toBe(1);
});
