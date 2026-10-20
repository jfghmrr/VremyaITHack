// @vitest-environment svelte-client
// connect() вызывают из $effect страниц дуэлей: эффект не должен подписываться на live.status.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inEffect } from "./effect-harness.svelte.ts";

/** Эффекты Svelte выполняются в микрозадачах: дождаться их. */
const settle = async () => {
  for (let k = 0; k < 10; k++) await Promise.resolve();
};

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.drop();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", { hidden: false, visibilityState: "visible", addEventListener: () => {} });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", { protocol: "https:", host: "perepev.test" });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: () => {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("connect() в $effect: смена статуса соединения не перезапускает эффект и не обходит задержку повтора", async () => {
  const { connect, live } = await import("../src/lib/live/client.svelte.ts");
  const effect = inEffect(() => connect());
  await settle();
  expect(effect.runs(), "эффект выполнился один раз").toBe(1);
  expect(FakeSocket.all).toHaveLength(1);
  // Соединение оборвалось: клиент ждёт задержку повтора, эффект страницы не вмешивается.
  FakeSocket.all[0].drop();
  await settle();
  expect(live.status).toBe("reconnecting");
  expect(effect.runs()).toBe(1);
  expect(FakeSocket.all, "новое соединение — только по таймеру повтора").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(800);
  expect(FakeSocket.all).toHaveLength(2);
  FakeSocket.all[1].open();
  await settle();
  expect(live.status).toBe("open");
  expect(effect.runs()).toBe(1);
  effect.stop();
});
