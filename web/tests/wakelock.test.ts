import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireWakeLock } from "../src/lib/ui/wakelock";

// Экран не гаснет во время пения: запрос Screen Wake Lock, повтор после возврата
// на вкладку и освобождение при остановке. Без поддержки API — тихий no-op.
class FakeSentinel extends EventTarget {
  released = false;
  readonly type = "screen";
  async release() {
    this.released = true;
  }
}

let doc: EventTarget & { visibilityState: DocumentVisibilityState };
let requests: FakeSentinel[];
let fail = false;

beforeEach(() => {
  requests = [];
  fail = false;
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", {
    wakeLock: {
      request: vi.fn(async (type: string) => {
        if (type !== "screen") throw new TypeError("type");
        if (fail) throw new DOMException("denied", "NotAllowedError");
        const s = new FakeSentinel();
        requests.push(s);
        return s;
      }),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));
const setVisibility = (state: DocumentVisibilityState) => {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event("visibilitychange"));
};

it("без поддержки API возвращает пустое освобождение", async () => {
  vi.stubGlobal("navigator", {});
  const release = await acquireWakeLock();
  expect(() => release()).not.toThrow();
});

it("держит экран включённым и отпускает при остановке", async () => {
  const release = await acquireWakeLock();
  expect(requests).toHaveLength(1);
  expect(requests[0].released).toBe(false);
  release();
  await flush();
  expect(requests[0].released).toBe(true);
  release();
  setVisibility("visible");
  await flush();
  expect(requests).toHaveLength(1);
});

it("после возврата на вкладку запрашивает блокировку снова, пока пение идёт", async () => {
  const release = await acquireWakeLock();
  // Браузер сам снимает блокировку, когда вкладка скрыта.
  requests[0].released = true;
  setVisibility("hidden");
  await flush();
  expect(requests).toHaveLength(1);
  setVisibility("visible");
  await flush();
  expect(requests).toHaveLength(2);
  release();
  await flush();
  expect(requests[1].released).toBe(true);
});

it("отказ браузера не ломает пение", async () => {
  fail = true;
  const release = await acquireWakeLock();
  expect(requests).toHaveLength(0);
  expect(() => release()).not.toThrow();
});
