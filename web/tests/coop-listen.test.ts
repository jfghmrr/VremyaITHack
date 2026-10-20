// «Вместе», прослушивание на итоге: синтезированный голос сменяется настоящими голосами при любом
// порядке событий — запись партнёра пришла до нажатия, пока звук запускался, во время звучания,
// после конца; игрок сам выбрал синтез; «Стоп» и уход со страницы во время передачи.
import { describe, expect, it } from "vitest";
import { backingLoader, CoopListening, shouldHandOver, type Backing, type ListenPlayer } from "../src/lib/duel/coop-listen";
import { afterEach, vi } from "vitest";

class Ctx {
  currentTime = 10;
  closed = false;
}

interface Fake extends ListenPlayer {
  kind: "real" | "synth";
  from: number;
  to: number;
  /** Минус, с которым запущен звук (null — без минуса). */
  backing: string | null;
  /** Время остановки на часах контекста (последний вызов stop). */
  stoppedAt: number | null;
  end: () => void;
}

/** Запуск, который завершается, когда тест скажет (как await ctx.resume() и сборка графа). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

function bench(track: () => Promise<{ buffer: string | null; missing: boolean }> = async () => ({ buffer: "минус", missing: false })) {
  const ctxs: Ctx[] = [];
  const players: Fake[] = [];
  const pending: { kind: "real" | "synth"; make: () => Fake; d: ReturnType<typeof deferred<Fake>> }[] = [];
  let changes = 0;
  const start = (kind: "real" | "synth", ctx: Ctx, from: number, to: number, onEnd: () => void, backing: string | null, at?: number) => {
    const d = deferred<Fake>();
    const make = () => {
      const startsAt = at ?? ctx.currentTime + 0.08;
      const p: Fake = {
        kind,
        from,
        to,
        backing,
        startsAt,
        stoppedAt: null,
        end: onEnd,
        get position() {
          return ctx.currentTime - startsAt + from;
        },
        positionAt: (t: number) => t - startsAt + from,
        stop(when?: number) {
          p.stoppedAt = when ?? ctx.currentTime;
        },
      };
      players.push(p);
      return p;
    };
    pending.push({ kind, make, d });
    return d.promise;
  };
  const ctl = new CoopListening<Ctx, string>({
    context: () => {
      const c = new Ctx();
      ctxs.push(c);
      return c;
    },
    close: (c) => void (c.closed = true),
    backing: track,
    synth: (ctx, from, to, onEnd, backing) => start("synth", ctx, from, to, onEnd, backing),
    real: (ctx, from, to, onEnd, backing, at) => start("real", ctx, from, to, onEnd, backing, at),
    changed: () => void changes++,
  });
  /** Довести ожидающий запуск: звук начинается. */
  const settle = async (kind: "real" | "synth") => {
    await tick();
    const i = pending.findIndex((p) => p.kind === kind);
    const [p] = pending.splice(i, 1);
    p.d.resolve(p.make());
    await new Promise((r) => setTimeout(r, 0));
  };
  const fail = async (kind: "real" | "synth") => {
    await tick();
    const i = pending.findIndex((p) => p.kind === kind);
    const [p] = pending.splice(i, 1);
    p.d.reject(new Error("closed"));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { ctl, ctxs, players, pending, settle, fail, changes: () => changes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("решение о передаче", () => {
  it("только синтез звучит, обе записи здесь, игрок синтез сам не выбирал и передача ещё не идёт", () => {
    const base = { realReady: true, chosen: false, playing: "synth" as const, handing: false };
    expect(shouldHandOver(base)).toBe(true);
    expect(shouldHandOver({ ...base, realReady: false })).toBe(false);
    expect(shouldHandOver({ ...base, chosen: true })).toBe(false);
    expect(shouldHandOver({ ...base, playing: "real" })).toBe(false);
    expect(shouldHandOver({ ...base, playing: null })).toBe(false);
    expect(shouldHandOver({ ...base, handing: true })).toBe(false);
  });
});

describe("порядок событий", () => {
  it("запись пришла до нажатия: сразу настоящие голоса, синтез не запускается", async () => {
    const b = bench();
    b.ctl.set({ realReady: true, chosen: false });
    void b.ctl.listen("real", 0, 14, null);
    await b.settle("real");
    expect(b.ctl.playing).toBe("real");
    expect(b.players.map((p) => p.kind)).toEqual(["real"]);
  });

  it("запись пришла, пока синтез запускался (ожидание listen): после запуска — передача", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await tick();
    // Запуск ещё ждёт контекст — запись партнёра уже здесь.
    b.ctl.set({ realReady: true, chosen: false });
    expect(b.pending.map((p) => p.kind)).toEqual(["synth"]);
    await b.settle("synth");
    expect(b.pending.map((p) => p.kind), "передача началась сама").toEqual(["real"]);
    await b.settle("real");
    const [synth, real] = b.players;
    expect(b.ctl.playing).toBe("real");
    expect(real.startsAt).toBeGreaterThan(b.ctxs[0].currentTime);
    // Синтез смолкает ровно там, где вступает сведение: ни паузы, ни наложения.
    expect(synth.stoppedAt).toBe(real.startsAt);
    // Сведение продолжает песню с того места, где синтез будет в момент передачи.
    expect(real.from).toBeCloseTo(synth.positionAt(real.startsAt), 9);
    expect(b.ctxs).toHaveLength(1);
  });

  it("запись пришла во время звучания синтеза: передача с текущего места на том же контексте", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctxs[0].currentTime += 3;
    b.ctl.set({ realReady: true, chosen: false });
    await b.settle("real");
    const [synth, real] = b.players;
    expect(b.ctl.playing).toBe("real");
    expect(real.from).toBeGreaterThan(2.9);
    expect(synth.stoppedAt).toBe(real.startsAt);
    expect(b.ctxs).toHaveLength(1);
    expect(b.ctxs[0].closed).toBe(false);
  });

  it("запись пришла после конца прослушивания: ничего не запускается", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.players[0].end();
    expect(b.ctl.playing).toBeNull();
    b.ctl.set({ realReady: true, chosen: false });
    await tick();
    expect(b.pending).toEqual([]);
    expect(b.ctxs[0].closed).toBe(true);
  });

  it("игрок сам выбрал синтезированный голос: передачи нет", async () => {
    const b = bench();
    b.ctl.set({ realReady: true, chosen: true });
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    await tick();
    expect(b.pending).toEqual([]);
    expect(b.ctl.playing).toBe("synth");
  });

  it("повторные сигналы во время передачи не запускают второе сведение", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctl.set({ realReady: true, chosen: false });
    b.ctl.set({ realReady: true, chosen: false });
    await tick();
    expect(b.pending.filter((p) => p.kind === "real")).toHaveLength(1);
  });

  it("до конца меньше 0,3 с: передачи нет, синтез доигрывает", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctxs[0].currentTime += 13.7;
    b.ctl.set({ realReady: true, chosen: false });
    await tick();
    expect(b.pending).toEqual([]);
  });
});

describe("«Стоп» и уход со страницы во время передачи", () => {
  it("«Стоп», пока сведение запускается: всё смолкает, контекст закрыт, запоздавшее сведение сразу останавливается", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctl.set({ realReady: true, chosen: false });
    b.ctl.stop();
    const synth = b.players[0];
    expect(synth.stoppedAt).toBe(b.ctxs[0].currentTime);
    expect(b.ctxs[0].closed).toBe(true);
    expect(b.ctl.playing).toBeNull();
    await b.settle("real");
    const real = b.players[1];
    expect(real.stoppedAt, "сведение остановлено сразу").not.toBeNull();
    expect(b.ctl.playing).toBeNull();
    expect(b.ctl.window).toBeNull();
  });

  it("уход со страницы (stop при размонтировании), а запуск сведения падает на закрытом контексте: без ошибки на экране", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctl.set({ realReady: true, chosen: false });
    b.ctl.stop();
    await b.fail("real");
    expect(b.ctl.error).toBe("");
    expect(b.ctl.playing).toBeNull();
  });

  it("сбой передачи при живом прослушивании: синтез доигрывает, без ошибки", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctl.set({ realReady: true, chosen: false });
    await b.fail("real");
    expect(b.ctl.playing).toBe("synth");
    expect(b.players[0].stoppedAt).toBeNull();
    expect(b.ctl.error).toBe("");
  });

  it("новое нажатие во время запуска: прежний не зазвучит, его контекст закрыт", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    void b.ctl.listen("synth", 2, 5, 2.3);
    expect(b.ctxs[0].closed).toBe(true);
    await b.settle("synth");
    expect(b.players).toHaveLength(1);
    expect(b.players[0].from).toBe(2);
    expect(b.ctl.playing).toBe("synth");
    expect(b.ctl.window).toEqual({ from: 2, to: 5, moment: 2.3 });
  });

  it("новое нажатие, когда прежний звук уже собирается: прежний останавливается сразу", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await tick();
    expect(b.pending).toHaveLength(1);
    void b.ctl.listen("synth", 2, 5, 2.3);
    await b.settle("synth");
    expect(b.players[0].from).toBe(0);
    expect(b.players[0].stoppedAt).not.toBeNull();
    await b.settle("synth");
    expect(b.ctl.window).toEqual({ from: 2, to: 5, moment: 2.3 });
  });

  it("ошибка запуска текущего прослушивания видна игроку", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.fail("synth");
    expect(b.ctl.error).toMatch(/^Не удалось запустить звук: closed/);
    expect(b.ctl.playing).toBeNull();
  });
});

describe("минус песни всегда под голосами", () => {
  it("минус ещё декодируется: контекст создан сразу по нажатию, звук ждёт минус («Готовим минус…»), затем голоса и минус вместе", async () => {
    const track = deferred<{ buffer: string | null; missing: boolean }>();
    const b = bench(() => track.promise);
    void b.ctl.listen("synth", 0, 14, null);
    expect(b.ctxs, "контекст — в обработчике нажатия").toHaveLength(1);
    expect(b.ctl.preparing).toBe(true);
    expect(b.ctl.window).toEqual({ from: 0, to: 14, moment: null });
    await tick();
    expect(b.pending, "голоса не запускаются без минуса").toEqual([]);
    track.resolve({ buffer: "минус", missing: false });
    await b.settle("synth");
    expect(b.ctl.preparing).toBe(false);
    expect(b.ctl.playing).toBe("synth");
    expect(b.players[0].backing).toBe("минус");
    expect(b.ctl.backingMissing).toBe(false);
  });

  it("настоящие голоса и передача — с тем же минусом", async () => {
    const b = bench();
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    b.ctl.set({ realReady: true, chosen: false });
    await b.settle("real");
    expect(b.players.map((p) => [p.kind, p.backing])).toEqual([
      ["synth", "минус"],
      ["real", "минус"],
    ]);
    const c = bench();
    c.ctl.set({ realReady: true, chosen: false });
    void c.ctl.listen("real", 0, 14, null);
    await c.settle("real");
    expect(c.players[0].backing).toBe("минус");
  });

  it("минус не загрузился (сеть): голоса звучат без него, и это видно (backingMissing)", async () => {
    const b = bench(async () => ({ buffer: null, missing: true }));
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    expect(b.ctl.playing).toBe("synth");
    expect(b.players[0].backing).toBeNull();
    expect(b.ctl.backingMissing).toBe(true);
    b.ctl.stop();
    expect(b.ctl.backingMissing).toBe(false);
  });

  it("у песни нет минуса (нет stems): голоса без него, без пометки об ошибке", async () => {
    const b = bench(async () => ({ buffer: null, missing: false }));
    void b.ctl.listen("synth", 0, 14, null);
    await b.settle("synth");
    expect(b.ctl.backingMissing).toBe(false);
  });

  it("«Стоп» или уход, пока готовится минус: ничего не запускается, контекст закрыт", async () => {
    const track = deferred<{ buffer: string | null; missing: boolean }>();
    const b = bench(() => track.promise);
    void b.ctl.listen("synth", 0, 14, null);
    b.ctl.stop();
    expect(b.ctl.preparing).toBe(false);
    expect(b.ctxs[0].closed).toBe(true);
    track.resolve({ buffer: "минус", missing: false });
    await tick();
    await tick();
    expect(b.pending).toEqual([]);
    expect(b.ctl.playing).toBeNull();
  });
});

describe("пока готовился минус, пришла запись партнёра", () => {
  it("после минуса сразу настоящие голоса, без синтеза и без передачи", async () => {
    const track = deferred<{ buffer: string | null; missing: boolean }>();
    const b = bench(() => track.promise);
    void b.ctl.listen("synth", 0, 14, null);
    b.ctl.set({ realReady: true, chosen: false });
    track.resolve({ buffer: "минус", missing: false });
    await b.settle("real");
    expect(b.players.map((p) => p.kind)).toEqual(["real"]);
    expect(b.ctl.playing).toBe("real");
    expect(b.players[0].backing).toBe("минус");
  });

  it("игрок сам выбрал синтез — остаётся синтез", async () => {
    const track = deferred<{ buffer: string | null; missing: boolean }>();
    const b = bench(() => track.promise);
    b.ctl.set({ realReady: false, chosen: true });
    void b.ctl.listen("synth", 0, 14, null);
    b.ctl.set({ realReady: true, chosen: true });
    track.resolve({ buffer: "минус", missing: false });
    await b.settle("synth");
    expect(b.players.map((p) => p.kind)).toEqual(["synth"]);
  });
});

describe("загрузка минуса: следующее нажатие пробует снова", () => {
  afterEach(() => vi.useRealTimers());
  const ok: Backing<string> = { buffer: "минус", missing: false };
  const fail: Backing<string> = { buffer: null, missing: true };

  it("готовый минус берётся сразу, без новой загрузки", async () => {
    const load = vi.fn(async () => ok);
    const get = backingLoader(load, 15_000);
    get.prefetch();
    expect(await get.get()).toEqual(ok);
    expect(await get.get()).toEqual(ok);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("заранее начатая загрузка не удалась — первое же нажатие загружает заново", async () => {
    const answers = [fail, ok];
    const load = vi.fn(async () => answers.shift()!);
    const get = backingLoader(load, 15_000);
    get.prefetch();
    await Promise.resolve();
    await Promise.resolve();
    expect(await get.get()).toEqual(ok);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("загрузка повисла: через 15 с — без минуса, а следующее нажатие начинает новую", async () => {
    vi.useFakeTimers();
    const hang = new Promise<Backing<string>>(() => {});
    const loads = [() => hang, async () => ok];
    const load = vi.fn(() => loads.shift()!());
    const get = backingLoader(load, 15_000);
    get.prefetch();
    const first = get.get();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toEqual(fail);
    expect(await get.get()).toEqual(ok);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("загрузка, упавшая исключением, — тоже «не загрузился»", async () => {
    const get = backingLoader<string>(async () => {
      throw new Error("сеть");
    }, 15_000);
    expect(await get.get()).toEqual(fail);
  });
});
