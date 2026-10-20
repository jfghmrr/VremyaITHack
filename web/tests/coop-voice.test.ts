// «Вместе», настоящие голоса: своя запись — только свои ходы, 16 кГц PCM16, как у точной оценки;
// голос партнёра приходит PCM16 и сводится с минусом по времени песни.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVoice, mayRetry, mayShareVoice, ownVoice, pcm16ToFloat, recallLags, rememberLags, sendVoice, voiceNotes, voiceStart, type VoiceSituation } from "../src/lib/duel/coop-voice";
import { toPcm16 } from "../src/lib/precise/uploader";
import type { Turn } from "../src/lib/api/types";

const turns: Turn[] = [
  { slot: 0, start_s: 0.5, end_s: 1.0, lines: [0] },
  { slot: 1, start_s: 1.0, end_s: 1.5, lines: [1] },
];

it("своя запись: пересчёт в 16 кГц от нулевой секунды песни, вне своих ходов — тишина", () => {
  const rate = 48_000;
  const samples = new Float32Array(2 * rate).fill(0.25);
  const voice = ownVoice({ samples, sampleRate: rate }, turns, 1);
  expect(voice.length).toBe(32_000);
  const at = (t: number) => voice[Math.round(t * 16_000)];
  expect([at(0.2), at(0.7), at(1.2), at(1.7)]).toEqual([0, 0, 0.25, 0]);
  expect(voice.filter((v) => v !== 0).length).toBe(8_000);
});

it("PCM16 партнёра превращается в отсчёты −1…1", () => {
  const pcm = toPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]));
  const back = pcm16ToFloat(pcm.buffer);
  expect(Array.from(back).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.5, -0.5, 1, -1]);
  // Нечётная длина (обрыв) не ломает разбор.
  expect(pcm16ToFloat(new Uint8Array([1, 2, 3]).buffer)).toHaveLength(1);
});

it("старт голоса в сведении: задержка записи вычитается, раннее пение ждёт", () => {
  // Певец опоздал на 0,12 с: его запись начинается на 0,12 с дальше.
  expect(voiceStart(0, 0.12)).toEqual({ delay: 0, offset: 0.12 });
  expect(voiceStart(5, 0.12)).toEqual({ delay: 0, offset: 5.12 });
  // Певец спешил на 0,2 с и слушаем с начала: запись вступает на 0,2 с позже.
  expect(voiceStart(0, -0.2)).toEqual({ delay: 0.2, offset: 0 });
});

it("голос уходит, только если последний выбор самого игрока — «делиться» и сервер видит согласие обоих", () => {
  const both = [{ share_voice: true }, { share_voice: true }];
  expect(mayShareVoice(true, both)).toBe(true);
  // Галочку сняли в момент общего старта: сервер ещё показывает согласие, но выбор игрока важнее.
  expect(mayShareVoice(false, both)).toBe(false);
  // Игрок согласен, а сервер согласие не принял (отказ после старта) или партнёр против.
  expect(mayShareVoice(true, [{ share_voice: false }, { share_voice: true }])).toBe(false);
  expect(mayShareVoice(true, [{ share_voice: true }])).toBe(false);
  expect(mayShareVoice(true, [{}, { share_voice: true }])).toBe(false);
});

it("пояснение под прослушиванием честное: «не записывается» — только когда голосом не делились", async () => {
  const { listenNote } = await import("../src/lib/duel/coop-voice");
  const o = { partner: "Гоша", partnerLine: true };
  expect(listenNote("synth", { ...o, sharing: "none" })).toMatch(/^Голос в дуэлях не записывается\. Звучит синтезированный голос/);
  for (const kind of ["synth", "unavailable", "real"] as const) {
    expect(listenNote(kind, { ...o, sharing: "shared" }), kind).not.toMatch(/не записывается/);
  }
  expect(listenNote("real", { ...o, sharing: "shared" })).toMatch(/Звучат ваши настоящие голоса/);
  expect(listenNote("unavailable", { ...o, sharing: "shared" })).toMatch(/не дольше 10 минут/);
  expect(listenNote("unavailable", { ...o, sharing: "none" })).toMatch(/голос в дуэлях не записывается/);
  expect(listenNote("synth", { ...o, sharing: "withdrawn" })).toMatch(/^Записи голосов удалены/);
  expect(listenNote("synth", { ...o, sharing: "withdrawn" })).not.toMatch(/не записывается/);
  // После перезагрузки итога (слушать нечего) снятие тоже названо, а не «хранятся на сервере».
  expect(listenNote("unavailable", { ...o, sharing: "withdrawn" })).toMatch(/^Записи голосов удалены/);
  expect(listenNote("unavailable", { ...o, sharing: "withdrawn" })).not.toMatch(/хранятся на сервере/);
  expect(listenNote("synth", { ...o, sharing: "none", partnerLine: false })).toMatch(/Линия партнёра до этого устройства не дошла/);
});

it("состояние «делились ли голосом» для пояснения и кнопки — по согласию в состоянии матча от сервера", async () => {
  const { sharingOf } = await import("../src/lib/duel/coop-voice");
  // После перезагрузки итога своего выбора на странице уже нет, а согласие обоих сервер помнит:
  // копия на сервере может быть, кнопка снятия нужна.
  expect(sharingOf(false, [{ share_voice: true }, { share_voice: true }])).toBe("shared");
  expect(sharingOf(false, [{ share_voice: true }, { share_voice: false }])).toBe("none");
  expect(sharingOf(false, [{ share_voice: true }])).toBe("none");
  expect(sharingOf(true, [{ share_voice: true }, { share_voice: true }])).toBe("withdrawn");
});

describe("голос партнёра: ждём, пока сервер не скажет, что он уже не придёт", () => {
  const pcm = () => toPcm16(new Float32Array(16_000).fill(0.5)).buffer;
  const answer = (status: number) => new Response(status === 200 ? pcm() : JSON.stringify({ error: "x" }), { status });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("партнёр отправил запись через 70 с (срок отправки — 90 с): она приходит, страница не сдаётся через минуту", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => answer(Date.now() - start >= 70_000 ? 200 : 404)));
    const got = fetchVoice("m", 1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(75_000);
    const r = await got;
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.samples.length).toBe(16_000);
  });

  it("410 — запись уже не придёт (срок отправки прошёл или удалена), 403 — согласие снято", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(410)));
    expect(await fetchVoice("m", 1, new AbortController().signal)).toEqual({ kind: "gone" });
    vi.stubGlobal("fetch", vi.fn(async () => answer(403)));
    expect(await fetchVoice("m", 1, new AbortController().signal)).toEqual({ kind: "denied" });
  });

  it("401, 409 и прочие 4xx (кроме 404) — сразу ответ со своей причиной, без трёх минут ожидания", async () => {
    for (const [status, kind] of [
      [401, "signin"],
      [409, "changed"],
      [400, "rejected"],
      [422, "rejected"],
    ] as const) {
      const f = vi.fn(async () => answer(status));
      vi.stubGlobal("fetch", f);
      expect(await fetchVoice("m", 1, new AbortController().signal), String(status)).toEqual({ kind });
      expect(f, `${status}: один запрос`).toHaveBeenCalledTimes(1);
    }
  });

  it("404 и 5xx — ждём дальше", async () => {
    vi.useFakeTimers();
    const statuses = [404, 502, 503, 404, 200];
    const f = vi.fn(async () => answer(statuses.shift()!));
    vi.stubGlobal("fetch", f);
    const got = fetchVoice("m", 1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await got).kind).toBe("ok");
    expect(f).toHaveBeenCalledTimes(5);
  });

  it("сервер не отвечает долго — «не удалось получить», а не вечное ожидание", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network"))));
    const got = fetchVoice("m", 1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(await got).toEqual({ kind: "timeout" });
  });
});

describe("своя запись: ответ сервера на отправку", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (...statuses: (number | "network")[]) => {
    const f = vi.fn(async () => {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (s === "network") throw new TypeError("network");
      return new Response(s === 204 ? null : JSON.stringify({ error: "x" }), { status: s });
    });
    vi.stubGlobal("fetch", f);
    return f;
  };
  const voice = new Float32Array(160);

  it("принята — ok; у каждого отказа своя причина; повтор (и «Отправить ещё раз») — только при сбое сети или сервера", async () => {
    reply(204);
    expect(await sendVoice("m", voice)).toEqual({ ok: true });
    for (const [status, reason] of [
      [410, "late"],
      [403, "refused"],
      [429, "limit"],
      [401, "signin"],
      [409, "changed"],
      [400, "rejected"],
      [413, "rejected"],
    ] as const) {
      const f = reply(status);
      expect(await sendVoice("m", voice, 0), String(status)).toEqual({ ok: false, reason });
      expect(f, `${status}: без автоматического повтора`).toHaveBeenCalledTimes(1);
    }
    const f = reply(503, 503);
    expect(await sendVoice("m", voice, 0)).toEqual({ ok: false, reason: "error" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(mayRetry("error")).toBe(true);
    for (const r of ["late", "refused", "limit", "signin", "changed", "rejected"] as const) expect(mayRetry(r), r).toBe(false);
    reply("network", 204);
    expect(await sendVoice("m", voice, 0)).toEqual({ ok: true });
  });
});

describe("почему не звучат настоящие голоса — по-русски и точно", () => {
  const base = { sharing: "shared" as const, me: true, partner: true, upload: "sent" as const, own: "here" as const, theirs: "ready" as const, synth: true };
  const notes = (o: Partial<VoiceSituation>) => voiceNotes({ ...base, ...o }, "Гоша").join(" ");

  it("оба голоса на месте — пояснений нет", () => {
    expect(voiceNotes(base, "Гоша")).toEqual([]);
  });
  it("согласия: нет твоего, нет партнёра, нет ни у кого — без глаголов в мужском роде («Вика не дал»)", () => {
    expect(notes({ sharing: "none", me: false })).toBe("Настоящие голоса не звучат: перед песней не было твоего согласия поделиться голосом.");
    expect(notes({ sharing: "none", partner: false })).toBe("Настоящие голоса не звучат: нет согласия партнёра (Гоша) поделиться голосом.");
    expect(notes({ sharing: "none", me: false, partner: false })).toBe("Настоящие голоса не звучат: перед песней не было согласия поделиться голосом ни у тебя, ни у партнёра.");
    for (const o of [{ me: false }, { partner: false }, { me: false, partner: false }]) expect(notes({ sharing: "none", ...o })).not.toMatch(/ дал /);
  });
  it("ни одно пояснение не требует рода: ни «дал», ни «пел» о человеке", async () => {
    const { listenNote } = await import("../src/lib/duel/coop-voice");
    // \b в JS — только для латиницы: границы слова для кириллицы — явно.
    const gendered = /(?<![а-яё])(дал|пел|спел|снял|согласился|отправил)(?![а-яё])/iu;
    for (const kind of ["real", "synth", "unavailable"] as const) {
      for (const sharing of ["none", "shared", "withdrawn"] as const) {
        for (const partnerLine of [true, false]) expect(listenNote(kind, { sharing, partner: "Вика", partnerLine }), `${kind} ${sharing}`).not.toMatch(gendered);
      }
    }
    const all: Partial<VoiceSituation>[] = [
      { sharing: "none", me: false },
      { sharing: "none", partner: false },
      { sharing: "none", me: false, partner: false },
      ...(["sending", "failed", "late", "refused", "limit", "signin", "changed", "rejected"] as const).map((upload) => ({ upload })),
      ...(["waiting", "gone", "denied", "timeout", "signin", "changed", "rejected"] as const).map((theirs) => ({ theirs })),
      ...(["waiting", "gone", "denied", "timeout", "signin", "changed", "rejected"] as const).map((own) => ({ upload: "none" as const, own })),
    ];
    for (const o of all) expect(notes(o), JSON.stringify(o)).not.toMatch(gendered);
  });
  it("своя запись не сохранилась: почему и можно ли отправить ещё раз", () => {
    expect(notes({ upload: "failed" })).toMatch(/^Твоя запись не сохранилась на сервере.*Гоша слышит в твоих строках синтезированный голос.*Отправь её ещё раз/);
    expect(notes({ upload: "late" })).toMatch(/^Твоя запись не сохранилась: отправить её можно только в первые 90 секунд после песни/);
    expect(notes({ upload: "refused" })).toMatch(/согласие поделиться голосом снято/);
    expect(notes({ upload: "sending" })).toMatch(/^Отправляем твою запись/);
    expect(notes({ upload: "signin" })).toMatch(/^Твоя запись не сохранилась: сессия входа истекла/);
    expect(notes({ upload: "changed" })).toMatch(/^Твоя запись не сохранилась: версия песни на сервере изменилась/);
    expect(notes({ upload: "rejected" })).toMatch(/^Твоя запись не сохранилась: сервер её не принял/);
    for (const u of ["late", "refused", "limit", "signin", "changed", "rejected"] as const) expect(notes({ upload: u }), u).not.toMatch(/Отправь её ещё раз/);
  });
  it("запись не удалось получить: вход истёк, версия песни изменилась, сервер отказал", () => {
    expect(notes({ theirs: "signin" })).toMatch(/^Запись партнёра не удалось получить: сессия входа истекла/);
    expect(notes({ theirs: "changed" })).toMatch(/^Запись партнёра не удалось получить: версия песни на сервере изменилась/);
    expect(notes({ upload: "none", own: "rejected" })).toMatch(/^Твою запись не удалось получить с сервера: сервер отказал/);
  });
  it("запись партнёра: ждём, не пришла, недоступна, сервер не отвечает", () => {
    expect(notes({ theirs: "waiting" })).toMatch(/^Ждём запись партнёра \(Гоша\).*как только придёт, зазвучат настоящие голоса/);
    // Не пришла за срок или уже удалена (итог открыли через несколько минут) — партнёр не обвиняется.
    expect(notes({ theirs: "gone" })).toBe("Записи партнёра (Гоша) на сервере нет: её не отправили в первые 90 секунд после песни, или она уже удалена — записи хранятся несколько минут. В строках партнёра звучит синтезированный голос.");
    expect(notes({ theirs: "denied" })).toMatch(/^Запись партнёра недоступна: согласие поделиться голосом снято/);
    expect(notes({ theirs: "timeout" })).toMatch(/Проверить ещё раз/);
  });
  it("страницу открыли заново: своя запись — с сервера; если её там нет, так и сказано", () => {
    expect(notes({ upload: "none", own: "waiting" })).toMatch(/^Загружаем твою запись с сервера/);
    expect(notes({ upload: "none", own: "gone" })).toMatch(/^Твоей записи нет ни на этом устройстве, ни на сервере/);
  });
  it("без линий высоты (итог открыт заново) синтезированный голос не обещается", () => {
    const reload = { upload: "none" as const, own: "here" as const, synth: false };
    expect(notes({ ...reload, theirs: "waiting" })).toBe("Ждём запись партнёра (Гоша): она отправляется сразу после песни; как только придёт, зазвучат настоящие голоса.");
    for (const o of [{ theirs: "waiting" as const }, { theirs: "gone" as const }, { own: "gone" as const }]) expect(notes({ ...reload, ...o })).not.toMatch(/синтезированный/);
  });
});

it("задержки записи переживают перезагрузку итога в этой вкладке (sessionStorage), без хранилища — без ошибок", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  rememberLags("m1", { mine: 0.12, theirs: -0.05 });
  expect(recallLags("m1")).toEqual({ mine: 0.12, theirs: -0.05 });
  expect(recallLags("m2")).toBeNull();
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => rememberLags("m1", { mine: 0, theirs: 0 })).not.toThrow();
  expect(recallLags("m1")).toBeNull();
  vi.unstubAllGlobals();
});
