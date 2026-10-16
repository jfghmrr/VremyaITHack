// Точная оценка (контракт C3): во время пения голос уходит на сервер кусками по 5 секунд,
// 16 кГц моно PCM16; t = 0 — нулевая секунда песни. После пения клиент опрашивает статус,
// пока компьютер команды не вернёт итог, не сообщит об отказе или не истекут 25 секунд.
// Wi-Fi площадки бывает неровным: кусок, не дошедший с первого раза, отправляется ещё раз,
// а сбой связи или 5xx при опросе не обрывают ожидание итога.
import { documents } from "#lib/legal/operator.ts";
import type { ScoreResult } from "#lib/scoring/types.ts";

export type PlayMode = "headphones" | "speaker";
export type PreciseCap = null | "coverage" | "constant" | "words" | "bleed";

/** Итог сервера: поля ScoreResult плюс проверка слов. При wordsChecked ось rhythm уже включает слова. */
export interface PreciseResult extends ScoreResult {
  algorithm: string;
  wordsChecked: boolean;
  wordsSung: number | null;
  wordsScore: number | null;
  cap: PreciseCap;
}

/** «timeout» ставит клиент: сервер так и не ответил окончательно за 25 секунд опроса. */
export interface PerfStatus {
  status: "queued" | "running" | "done" | "failed" | "offline" | "timeout";
  result: PreciseResult | null;
}

export const RATE = 16_000;
const CHUNK = RATE * 5;
const POLL_MS = 700;
const POLL_LIMIT_MS = 25_000;
/** Пауза перед повторной отправкой куска. */
const RETRY_MS = 500;

/**
 * Потоковый ресемплер в 16 кГц с линейной интерполяцией. Выходной отсчёт k берётся в точке
 * k·rate/16000 исходного сигнала; позиции считаются в целых числах, поэтому обработка блоками
 * даёт ровно то же, что и обработка целиком.
 */
export class Resampler {
  private next = 0;
  private consumed = 0;
  private previous = 0;

  constructor(readonly rate: number) {}

  process(input: Float32Array): Float32Array {
    const total = this.consumed + input.length;
    if (!total) return new Float32Array(0);
    const last = Math.floor(((total - 1) * RATE) / this.rate);
    const out = new Float32Array(Math.max(0, last - this.next + 1));
    const at = (i: number) => (i < this.consumed ? this.previous : input[i - this.consumed]);
    for (let k = 0; k < out.length; k++) {
      const scaled = (this.next + k) * this.rate;
      const i = Math.floor(scaled / RATE);
      const fraction = (scaled - i * RATE) / RATE;
      const a = at(i);
      out[k] = fraction === 0 ? a : a + (at(i + 1) - a) * fraction;
    }
    this.next += out.length;
    if (input.length) this.previous = input[input.length - 1];
    this.consumed = total;
    return out;
  }
}

export const resample = (input: Float32Array, rate: number) => new Resampler(rate).process(input);

/** Float [-1, 1] → PCM16 с ограничением диапазона; NaN становится тишиной. */
export function toPcm16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : v > 0 ? Math.round(v * 32767) : v < 0 ? Math.round(v * 32768) : 0;
  }
  return out;
}

/** Копит 16-кГц звук и отдаёт полные 5-секундные куски по номерам; остаток — при flush(). */
export class PcmChunker {
  private resampler: Resampler | null = null;
  private readonly buffer = new Float32Array(CHUNK);
  private filled = 0;
  private seq = 0;
  private closed = false;

  constructor(private readonly send: (seq: number, data: Int16Array<ArrayBuffer>) => void) {}

  push(pcm: Float32Array, sampleRate: number) {
    if (this.closed) return;
    if (this.resampler?.rate !== sampleRate) this.resampler = new Resampler(sampleRate);
    const data = this.resampler.process(pcm);
    for (let at = 0; at < data.length; ) {
      const n = Math.min(CHUNK - this.filled, data.length - at);
      this.buffer.set(data.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === CHUNK) this.emit();
    }
  }

  /** Отправляет остаток и закрывает поток. Возвращает число отправленных кусков. */
  flush(): number {
    if (!this.closed && this.filled) this.emit();
    this.closed = true;
    return this.seq;
  }

  private emit() {
    this.send(this.seq++, toPcm16(this.buffer.subarray(0, this.filled)));
    this.filled = 0;
  }
}

/** Отказ сервера с кодом ответа: 5xx стоит повторить, 4xx — нет. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Точная оценка недоступна (${status}).`);
  }
}

/** Сбой связи или временная ошибка сервера. */
const transient = (e: unknown) => !(e instanceof HttpError) || e.status >= 500;

async function request(path: string, method: string, body: BodyInit, type: string, signal: AbortSignal) {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": type, "x-perepev-request": "1" },
    body,
    signal,
  });
  if (!response.ok) throw new HttpError(response.status);
  return response;
}

export interface PerfSession {
  /** Звук микрофона с начала песни; куски уходят на сервер по мере накопления. */
  push(pcm: Float32Array, sampleRate: number): void;
  /** Досылает остаток, завершает запись и возвращает её id для опроса. */
  finish(signal?: AbortSignal): Promise<string>;
  /** Попытка прервана: дальше ничего не отправляется. */
  cancel(): void;
}

/** Открывает запись на сервере сразу; куски, готовые раньше ответа, уходят по порядку после него. */
export function startPerf(songId: string, mode: PlayMode): PerfSession {
  const controller = new AbortController();
  const body = JSON.stringify({ songId, mode, voiceConsent: true, consentVersion: documents.consent });
  const created = request("perf", "POST", body, "application/json", controller.signal).then(async (r) => {
    const { id } = (await r.json()) as { id?: unknown };
    if (typeof id !== "string" || !id) throw new Error("Сервер не выдал номер записи.");
    return id;
  });
  let chain: Promise<unknown> = created;
  // Ошибку увидит finish(); до него отказ не должен всплывать как необработанный.
  chain.catch(() => {});
  const chunker = new PcmChunker((seq, data) => {
    chain = chain.then(async () => {
      const id = await created;
      controller.signal.throwIfAborted();
      const put = () => request(`perf/${encodeURIComponent(id)}/chunk?seq=${seq}`, "PUT", data, "application/octet-stream", controller.signal);
      try {
        await put();
      } catch (e) {
        // Один повтор: сервер заменяет кусок с тем же номером. Не дошёл и он — точной оценки не будет.
        if (controller.signal.aborted || !transient(e)) throw e;
        await wait(RETRY_MS, controller.signal);
        await put();
      }
    });
    chain.catch(() => {});
  });
  return {
    push: (pcm, sampleRate) => {
      if (!controller.signal.aborted) chunker.push(pcm, sampleRate);
    },
    async finish(signal) {
      signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      const chunks = chunker.flush();
      await chain;
      const id = await created;
      await request(`perf/${encodeURIComponent(id)}/finish`, "POST", JSON.stringify({ chunks }), "application/json", controller.signal);
      return id;
    },
    cancel: () => controller.abort(),
  };
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Опрос каждые 700 мс до done/failed/offline. Сбой связи и 5xx не прерывают опрос: он идёт
 * до 25 секунд, затем offline (связи так и не было) или timeout (сервер ещё считал). 4xx — сразу offline.
 */
export async function poll(id: string, signal: AbortSignal): Promise<PerfStatus> {
  const until = Date.now() + POLL_LIMIT_MS;
  for (;;) {
    signal.throwIfAborted();
    let status: PerfStatus | null = null;
    try {
      const response = await fetch(`/api/perf/${encodeURIComponent(id)}`, { credentials: "same-origin", signal });
      if (response.ok) status = (await response.json()) as PerfStatus;
      else if (response.status < 500) return { status: "offline", result: null };
    } catch (e) {
      if (signal.aborted) throw e;
      /* сбой связи: следующий опрос через 700 мс */
    }
    if (status?.status === "done") return { status: "done", result: status.result ?? null };
    if (status?.status === "failed" || status?.status === "offline") return { status: status.status, result: null };
    await wait(POLL_MS, signal);
    if (Date.now() >= until) return { status: status ? "timeout" : "offline", result: null };
  }
}
