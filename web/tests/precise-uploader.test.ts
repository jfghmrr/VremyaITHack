// Потоковая отправка голоса для точной оценки: ресемплинг в 16 кГц, PCM16, куски по 5 секунд
// и опрос статуса с пределом 25 секунд.
import { afterEach, expect, it, vi } from "vitest";
import { PcmChunker, Resampler, poll, resample, startPerf, toPcm16 } from "../src/lib/precise/uploader";
import { GUIDE_GAIN, loadLayers, songLayers } from "../src/lib/audio/playback";

const tone = (rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));

function concat(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("ресемплер 44100 → 16000: секунда звука даёт 16000 отсчётов, блоками — те же значения", () => {
  const second = tone(44100, 1);
  const whole = resample(second, 44100);
  expect(whole.length).toBe(16000);
  const r = new Resampler(44100);
  const parts: Float32Array[] = [];
  for (let i = 0; i < second.length; i += 2048) parts.push(r.process(second.subarray(i, i + 2048)));
  const streamed = concat(parts);
  expect(streamed.length).toBe(16000);
  let diff = 0;
  for (let i = 0; i < whole.length; i++) diff = Math.max(diff, Math.abs(whole[i] - streamed[i]));
  expect(diff).toBeLessThan(1e-6);
  // Линейная интерполяция: при кратной частоте берутся исходные отсчёты.
  const x = Float32Array.from({ length: 48 }, (_, i) => i / 48);
  expect(Array.from(resample(x, 48000)).map((v) => +v.toFixed(5))).toEqual(Array.from({ length: 16 }, (_, i) => +((i * 3) / 48).toFixed(5)));
  expect(resample(tone(16000, 2), 16000).length).toBe(32000);
});

it("PCM16: ограничение диапазона и округление", () => {
  expect(Array.from(toPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5, -0.5, Number.NaN)))).toEqual([0, 32767, -32768, 32767, -32768, 16384, -16384, 0]);
});

it("куски по 5 секунд: полные отправляются во время пения, остаток — при завершении", () => {
  const sent: { seq: number; bytes: number }[] = [];
  const chunker = new PcmChunker((seq, data) => sent.push({ seq, bytes: data.byteLength }));
  const audio = tone(44100, 12);
  for (let i = 0; i < audio.length; i += 2048) chunker.push(audio.subarray(i, i + 2048), 44100);
  expect(sent).toEqual([
    { seq: 0, bytes: 160_000 },
    { seq: 1, bytes: 160_000 },
  ]);
  expect(chunker.flush()).toBe(3);
  expect(sent[2]).toEqual({ seq: 2, bytes: 64_000 });
  expect(chunker.flush()).toBe(3);
  expect(sent).toHaveLength(3);
});

it("сессия: создание, куски по порядку и завершение с их числом", async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body as ArrayBuffer | undefined)?.byteLength });
    expect((init.headers as Record<string, string>)["x-perepev-request"]).toBe("1");
    if (method === "POST" && url === "/api/perf") return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
    return new Response(null, { status: method === "PUT" ? 204 : 202 });
  });
  const perf = startPerf("cn-earth", "speaker");
  const audio = tone(48000, 7);
  for (let i = 0; i < audio.length; i += 4096) perf.push(audio.subarray(i, i + 4096), 48000);
  await expect(perf.finish()).resolves.toBe("p1");
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/perf", "PUT /api/perf/p1/chunk?seq=0", "PUT /api/perf/p1/chunk?seq=1", "POST /api/perf/p1/finish"]);
  expect(calls[0].body).toEqual({ songId: "cn-earth", mode: "speaker", voiceConsent: true, consentVersion: "2026-10-18" });
  expect(calls[1].body).toBe(160_000);
  expect(calls[2].body).toBe(64_000);
  expect(calls[3].body).toEqual({ chunks: 2 });
});

it("сессия: если сервер не принял запись, завершение сообщает об ошибке, а не зависает", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
  const perf = startPerf("cn-earth", "headphones");
  perf.push(tone(44100, 6), 44100);
  await expect(perf.finish()).rejects.toThrow();
});

it("сессия: кусок, не дошедший с первого раза (сбой Wi-Fi или 5xx), отправляется ещё раз", async () => {
  const calls: string[] = [];
  const failures = new Map([["PUT /api/perf/p1/chunk?seq=0", 1], ["PUT /api/perf/p1/chunk?seq=1", 1]]);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = `${init.method ?? "GET"} ${url}`;
    calls.push(call);
    if ((failures.get(call) ?? 0) > 0) {
      failures.set(call, failures.get(call)! - 1);
      if (call.endsWith("seq=0")) throw new TypeError("Failed to fetch");
      return new Response("bad gateway", { status: 502 });
    }
    if (call === "POST /api/perf") return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
    return new Response(null, { status: init.method === "PUT" ? 204 : 202 });
  });
  const perf = startPerf("cn-earth", "headphones");
  perf.push(tone(16000, 7), 16000);
  await expect(perf.finish()).resolves.toBe("p1");
  expect(calls).toEqual([
    "POST /api/perf",
    "PUT /api/perf/p1/chunk?seq=0",
    "PUT /api/perf/p1/chunk?seq=0",
    "PUT /api/perf/p1/chunk?seq=1",
    "PUT /api/perf/p1/chunk?seq=1",
    "POST /api/perf/p1/finish",
  ]);
});

it("сессия: кусок не дошёл и со второй попытки — точная оценка отменяется, завершение сообщает об ошибке", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = `${init.method ?? "GET"} ${url}`;
    calls.push(call);
    if (call === "POST /api/perf") return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
    if (init.method === "PUT") throw new TypeError("Failed to fetch");
    return new Response(null, { status: 202 });
  });
  const perf = startPerf("cn-earth", "headphones");
  perf.push(tone(16000, 6), 16000);
  await expect(perf.finish()).rejects.toThrow();
  expect(calls.filter((c) => c.includes("seq=0"))).toHaveLength(2);
  expect(calls.some((c) => c.endsWith("/finish"))).toBe(false);
});

it("сессия: после отмены голос больше не отправляется", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method} ${url}`);
    if (init.signal?.aborted) throw new DOMException("Отменено", "AbortError");
    return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
  });
  const perf = startPerf("cn-earth", "headphones");
  perf.push(tone(44100, 6), 44100);
  perf.cancel();
  perf.push(tone(44100, 6), 44100);
  await expect(perf.finish()).rejects.toThrow();
  expect(calls.filter((c) => c.startsWith("PUT") || c.endsWith("/finish"))).toEqual([]);
});

it("сессия: завершение не ждёт дольше внешнего сигнала", async () => {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit = {}) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Отменено", "AbortError")))));
  const perf = startPerf("cn-earth", "headphones");
  perf.push(tone(44100, 1), 44100);
  const deadline = new AbortController();
  const finished = perf.finish(deadline.signal);
  deadline.abort();
  await expect(finished).rejects.toThrow();
});

it("дорожки песни: в наушниках минус и тихая подсказка, без наушников только минус, без stems — исходный микс", () => {
  expect(GUIDE_GAIN).toBe(0.18);
  expect(songLayers("backing.mp3", true, "headphones")).toEqual([{ file: "instrumental.mp3", gain: 1 }, { file: "guide.mp3", gain: 0.18 }]);
  expect(songLayers("backing.mp3", true, "speaker")).toEqual([{ file: "instrumental.mp3", gain: 1 }]);
  expect(songLayers("backing.mp3", false, "headphones")).toEqual([{ file: "backing.mp3", gain: 1 }]);
  expect(songLayers("backing.mp3", false, "speaker")).toEqual([{ file: "backing.mp3", gain: 1 }]);
});

it("опрос: каждые 700 мс до готовности", async () => {
  vi.useFakeTimers();
  const answers = ["queued", "running", "done"];
  let n = 0;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: answers[Math.min(n++, 2)], result: n >= 3 ? { score: 77 } : null }), { status: 200 }));
  const pending = poll("p1", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000);
  const status = await pending;
  expect(status.status).toBe("done");
  expect(status.result).toEqual({ score: 77 });
  expect(n).toBe(3);
});

it("опрос: через 25 секунд в статусе running результат считается непроверенным", async () => {
  vi.useFakeTimers();
  let n = 0;
  vi.stubGlobal("fetch", async () => {
    n++;
    return new Response(JSON.stringify({ status: "running", result: null }), { status: 200 });
  });
  const pending = poll("p1", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(26_000);
  await expect(pending).resolves.toEqual({ status: "timeout", result: null });
  expect(n).toBeGreaterThan(30);
  expect(n).toBeLessThan(40);
});

it("опрос: Wi-Fi площадки — сбой связи и 5xx не обрывают опрос, итог приходит до 25 секунд", async () => {
  vi.useFakeTimers();
  const answers: (() => Response)[] = [
    () => {
      throw new TypeError("Failed to fetch");
    },
    () => new Response("bad gateway", { status: 502 }),
    () => new Response(JSON.stringify({ status: "running", result: null }), { status: 200 }),
    () => new Response("unavailable", { status: 503 }),
    () => new Response(JSON.stringify({ status: "done", result: { score: 81 } }), { status: 200 }),
  ];
  let n = 0;
  vi.stubGlobal("fetch", async () => answers[Math.min(n++, answers.length - 1)]());
  const pending = poll("p1", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(pending).resolves.toEqual({ status: "done", result: { score: 81 } });
  expect(n).toBe(5);
});
it("опрос: связи нет все 25 секунд — «нет связи», опрос не бросается после первой ошибки", async () => {
  vi.useFakeTimers();
  let n = 0;
  vi.stubGlobal("fetch", async () => {
    n++;
    throw new TypeError("offline");
  });
  const pending = poll("p1", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  expect(n).toBeGreaterThan(2);
  await vi.advanceTimersByTimeAsync(23_000);
  await expect(pending).resolves.toEqual({ status: "offline", result: null });
  expect(n).toBeLessThan(40);
});
it("опрос: 404 (записи нет) — сразу без результата", async () => {
  vi.useFakeTimers();
  let n = 0;
  vi.stubGlobal("fetch", async () => {
    n++;
    return new Response("{}", { status: 404 });
  });
  const pending = poll("p1", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toEqual({ status: "offline", result: null });
  expect(n).toBe(1);
});

it("дорожки песни: минус или подсказка не загрузились — звучит исходный микс backing.mp3, проверка микрофона не падает", async () => {
  const loaded: string[] = [];
  const load = async (file: string) => {
    loaded.push(file);
    if (file === "guide.mp3") throw new Error("Не удалось загрузить guide.mp3");
    return { file } as unknown as AudioBuffer;
  };
  const fallback = await loadLayers("backing.mp3", true, "headphones", load);
  expect(fallback.stems).toBe(false);
  expect(fallback.layers).toEqual([{ buffer: { file: "backing.mp3" }, gain: 1 }]);
  expect(loaded).toContain("backing.mp3");

  const ok = await loadLayers("backing.mp3", true, "headphones", async (file) => ({ file }) as unknown as AudioBuffer);
  expect(ok.stems).toBe(true);
  expect(ok.layers.map((l) => l.gain)).toEqual([1, GUIDE_GAIN]);

  // Без отдельных дорожек запасного варианта нет: ошибка исходного микса доходит до проверки микрофона.
  await expect(loadLayers("backing.mp3", false, "speaker", async () => Promise.reject(new Error("нет файла")))).rejects.toThrow("нет файла");
  await expect(loadLayers("backing.mp3", true, "speaker", async () => Promise.reject(new Error("сеть")))).rejects.toThrow("сеть");
});
