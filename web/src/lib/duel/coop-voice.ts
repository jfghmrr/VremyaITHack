// «Вместе», настоящие голоса для общего прослушивания (только если согласились оба).
// После песни браузер отправляет запись своих ходов — PCM16 LE, 16 кГц, моно, от нулевой секунды
// песни, как у точной оценки, — на PUT /api/matches/{id}/voice; сервер ещё раз обнуляет всё вне
// ходов и хранит файл несколько минут. Голос партнёра забирается GET …/voice/{слот} и сводится
// с минусом по времени песни. Без согласия обоих звучит синтезированный голос (curve-voice.ts).
import type { Turn } from "#lib/api/types.ts";
import { normalizeRecording } from "#lib/audio/level.ts";
import { RATE, resample, toPcm16 } from "#lib/precise/uploader.ts";
import { silence } from "#lib/audio/curve-voice.ts";
import { inTurns } from "./coop.ts";

/**
 * Голос партнёра ждём, пока сервер отвечает «ещё не загружен» (404): после срока отправки
 * (90 с после песни, voices.rs) он отвечает 410, и ждать больше нечего. Своего предела у
 * ожидания нет — раньше он был 60 с, меньше срока отправки, и запись, отправленная партнёром
 * на 61-й секунде, не звучала. GIVE_UP_MS — только страховка, если сервер долго не отвечает.
 */
const GIVE_UP_MS = 3 * 60_000;
const POLL_MS = 1_200;

/**
 * Можно ли отправить свой голос: последний выбор самого игрока — «делиться» и в состоянии матча
 * от сервера согласны оба. Только серверного флага мало: галочку могли снять в момент общего
 * старта, а состояние с этим снятием ещё не пришло.
 */
export function mayShareVoice(choice: boolean, players: { share_voice?: boolean }[]): boolean {
  return choice && players.length === 2 && players.every((p) => p.share_voice === true);
}

/** Делились ли голосом: нет, да (оба согласны) или игрок снял согласие и записи удалены. */
export type Sharing = "none" | "shared" | "withdrawn";

/**
 * Делились ли голосом — для пояснения и кнопки снятия согласия: по согласию обоих в состоянии
 * матча от сервера (после перезагрузки итога выбора на странице нет, а копия на сервере может
 * быть) или «снято», если игрок уже снял согласие здесь. Решение об отправке своего голоса
 * принимается отдельно, по своему выбору на странице (`mayShareVoice`).
 */
export function sharingOf(withdrawn: boolean, players: { share_voice?: boolean }[]): Sharing {
  if (withdrawn) return "withdrawn";
  return players.length === 2 && players.every((p) => p.share_voice === true) ? "shared" : "none";
}

/**
 * Честное пояснение под «Прослушать всю песню». «Голос не записывается» — только когда голосом
 * не делились; при согласии обоих голос своих ходов уходил на сервер на несколько минут.
 * `real` — звучат записи; `synth` — синтезированный голос по линиям; `unavailable` — на этом
 * устройстве нечего слушать (оно не пело или страницу открыли заново).
 */
export function listenNote(kind: "real" | "synth" | "unavailable", o: { sharing: Sharing; partner: string; partnerLine: boolean }): string {
  if (kind === "real") {
    return `Звучат ваши настоящие голоса — записи ваших ходов, которыми вы согласились поделиться, — под минус песни: твои строки слева, ${o.partner} — справа. Записи удаляются с сервера не позже чем через 10 минут после песни.`;
  }
  if (kind === "unavailable") {
    if (o.sharing === "withdrawn") return "Записи голосов удалены по твоей просьбе. Прослушивание всей песни доступно сразу после неё на устройстве, где исполнялась твоя партия.";
    return o.sharing === "none"
      ? "Прослушивание всей песни доступно сразу после неё на устройстве, где исполнялась твоя партия: голос в дуэлях не записывается, а линии высоты остаются в браузере только до ухода со страницы."
      : "Прослушивание всей песни доступно сразу после неё на устройстве, где исполнялась твоя партия: линии высоты остаются в браузере только до ухода со страницы, а записи ваших ходов хранятся на сервере не дольше 10 минут.";
  }
  const prefix = o.sharing === "none" ? "Голос в дуэлях не записывается. " : o.sharing === "withdrawn" ? "Записи голосов удалены по твоей просьбе. " : "";
  const missing = o.partnerLine ? "" : " Линия партнёра до этого устройства не дошла: звучит только твоя партия.";
  return `${prefix}Звучит синтезированный голос, который повторяет мелодию каждого из вас (линию высоты, без тембра и слов): твои строки слева, ${o.partner} — справа, каждый в свои ходы, под минус песни и в его тональности.${missing}`;
}

/** Своя запись для партнёра: 16 кГц от нулевой секунды песни, вне своих ходов — тишина. */
export function ownVoice(rec: { samples: Float32Array; sampleRate: number }, turns: Turn[], slot: number): Float32Array {
  const voice = resample(rec.samples, rec.sampleRate);
  for (let i = 0; i < voice.length; i++) if (!inTurns(turns, slot, i / RATE)) voice[i] = 0;
  return voice;
}

/** PCM16 LE → отсчёты −1…1. */
export function pcm16ToFloat(bytes: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] < 0 ? pcm[i] / 32768 : pcm[i] / 32767;
  return out;
}

/**
 * Когда и с какого места звучит голос в сведении, если слушать с момента песни `from`:
 * задержка записи `lag` (как в оценке) вычитается — опоздавший голос начинается дальше
 * в записи, поспешивший вступает позже.
 */
export function voiceStart(from: number, lag: number): { delay: number; offset: number } {
  const offset = from + lag;
  return offset >= 0 ? { delay: 0, offset } : { delay: -offset, offset: 0 };
}

/**
 * Почему своя запись не сохранилась: `error` — сбой сети или сервера (после одного повтора):
 * только тогда можно отправить ещё раз; `late` — срок отправки (90 с после песни) прошёл,
 * `refused` — согласие снято, `limit` — слишком много отправок за час, `signin` — сессия входа
 * истекла, `changed` — версия песни на сервере изменилась, `rejected` — сервер запись не принял.
 */
export type SendFailure = "error" | "late" | "refused" | "limit" | "signin" | "changed" | "rejected";
export type VoiceSend = { ok: true } | { ok: false; reason: SendFailure };

/** Повторная отправка поможет только при сбое сети или сервера. */
export const mayRetry = (reason: SendFailure) => reason === "error";

/** Ответ сервера (не 2xx) → причина отказа; null — сбой сервера, стоит повторить. */
function sendFailure(status: number): SendFailure | null {
  if (status >= 500) return null;
  if (status === 410) return "late";
  if (status === 403) return "refused";
  if (status === 429) return "limit";
  if (status === 401) return "signin";
  if (status === 409) return "changed";
  return "rejected";
}

/** Отправляет свою запись; повтор один раз при сбое сети или сервера. */
export async function sendVoice(matchId: string, voice: Float32Array, retryMs = 600): Promise<VoiceSend> {
  const body = toPcm16(voice);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`/api/matches/${encodeURIComponent(matchId)}/voice`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/octet-stream", "x-perepev-request": "1" },
        body,
      });
      if (r.ok) return { ok: true };
      const reason = sendFailure(r.status);
      if (reason) return { ok: false, reason };
    } catch {
      /* сеть: повтор */
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return { ok: false, reason: "error" };
}

/**
 * Ответ на запрос голоса: `gone` — уже не придёт (не отправлен за срок или удалён, 410),
 * `denied` — согласие снято (403), `signin` — сессия входа истекла (401), `changed` — версия
 * песни на сервере изменилась (409), `rejected` — другой отказ 4xx, `timeout` — сервер долго не
 * отвечает, `aborted` — страница ушла. Ждать дальше стоит только при 404 (ещё не загружен) и 5xx.
 */
export type VoiceFetch =
  | { kind: "ok"; samples: Float32Array }
  | { kind: "gone" | "denied" | "signin" | "changed" | "rejected" | "timeout" | "aborted" };

/** Голос участника `slot` (партнёра или свой, например после перезагрузки итога): ждёт, пока он загрузится. */
export async function fetchVoice(matchId: string, slot: number, signal: AbortSignal): Promise<VoiceFetch> {
  const until = Date.now() + GIVE_UP_MS;
  while (!signal.aborted && Date.now() < until) {
    try {
      const r = await fetch(`/api/matches/${encodeURIComponent(matchId)}/voice/${slot}`, { credentials: "same-origin", signal });
      if (r.ok) return { kind: "ok", samples: pcm16ToFloat(await r.arrayBuffer()) };
      if (r.status === 410) return { kind: "gone" };
      if (r.status === 403) return { kind: "denied" };
      if (r.status === 401) return { kind: "signin" };
      if (r.status === 409) return { kind: "changed" };
      if (r.status !== 404 && r.status < 500) return { kind: "rejected" };
      // 404 — ещё не загружен, 5xx — временно: ждём дальше.
    } catch {
      if (signal.aborted) return { kind: "aborted" };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return signal.aborted ? { kind: "aborted" } : { kind: "timeout" };
}

/**
 * Отправка своей записи с этого устройства: не было, идёт, принята, не сохранилась (`failed` —
 * сбой сети или сервера, можно отправить ещё раз; остальное — причина отказа, см. SendFailure).
 */
export type Upload = "none" | "sending" | "sent" | "failed" | Exclude<SendFailure, "error">;
/** Запись для сведения: есть, ждём с сервера, или почему её нет (см. VoiceFetch). */
export type Arrival = "here" | "waiting" | "gone" | "denied" | "timeout" | "signin" | "changed" | "rejected";

/** Почему запись не удалось получить (отказ сервера, не «ещё не готово»). */
const FETCH_REFUSAL: Partial<Record<Arrival, string>> = {
  signin: "сессия входа истекла — войди снова и открой итог ещё раз",
  changed: "версия песни на сервере изменилась",
  rejected: "сервер отказал в доступе",
};

export interface VoiceSituation {
  sharing: Sharing;
  /** Согласия из состояния матча от сервера: своё и партнёра. */
  me: boolean;
  partner: boolean;
  upload: Upload;
  /** Своя запись для сведения: на этом устройстве или с сервера (после перезагрузки итога). */
  own: Arrival;
  theirs: Arrival | "ready";
  /** Есть ли на этой странице синтезированный голос (линии высоты; после перезагрузки итога — нет). */
  synth: boolean;
}

/**
 * Почему настоящие голоса не звучат (или ещё не звучат) — строки для итога. Пусто, когда оба
 * голоса на месте, когда согласие снято здесь же (об этом говорит listenNote) и когда отправка
 * прошла. Имя партнёра — только в именительном падеже, как везде на итоге.
 */
export function voiceNotes(s: VoiceSituation, partner: string): string[] {
  if (s.sharing === "withdrawn") return [];
  if (s.sharing === "none") {
    // Без глаголов прошедшего времени: «Вика не дал» звучит неверно, а род из имени не узнать.
    if (!s.me && !s.partner) return ["Настоящие голоса не звучат: перед песней не было согласия поделиться голосом ни у тебя, ни у партнёра."];
    if (!s.me) return ["Настоящие голоса не звучат: перед песней не было твоего согласия поделиться голосом."];
    return [`Настоящие голоса не звучат: нет согласия партнёра (${partner}) поделиться голосом.`];
  }
  const out: string[] = [];
  const synthForPartner = `${partner} слышит в твоих строках синтезированный голос.`;
  if (s.upload === "sending") out.push("Отправляем твою запись партнёру…");
  else if (s.upload === "failed") out.push(`Твоя запись не сохранилась на сервере, поэтому ${synthForPartner} Отправь её ещё раз: это можно сделать в первые 90 секунд после песни.`);
  else if (s.upload === "late") out.push(`Твоя запись не сохранилась: отправить её можно только в первые 90 секунд после песни, а этот срок прошёл. ${synthForPartner}`);
  else if (s.upload === "refused") out.push("Твоя запись не сохранилась: согласие поделиться голосом снято.");
  else if (s.upload === "limit") out.push(`Твоя запись не сохранилась: слишком много отправок голоса за час. ${synthForPartner}`);
  else if (s.upload === "signin") out.push(`Твоя запись не сохранилась: сессия входа истекла. ${synthForPartner}`);
  else if (s.upload === "changed") out.push(`Твоя запись не сохранилась: версия песни на сервере изменилась. ${synthForPartner}`);
  else if (s.upload === "rejected") out.push(`Твоя запись не сохранилась: сервер её не принял. ${synthForPartner}`);
  if (s.own === "waiting") out.push("Загружаем твою запись с сервера…");
  else if (s.own === "gone") out.push("Твоей записи нет ни на этом устройстве, ни на сервере: страницу открыли заново, а запись не дошла до сервера или уже удалена.");
  else if (s.own === "denied") out.push("Твоя запись недоступна: согласие поделиться голосом снято, записи удалены с сервера.");
  else if (s.own === "timeout") out.push("Твою запись не удалось получить с сервера: он не отвечает. Проверь связь и нажми «Проверить ещё раз».");
  else if (FETCH_REFUSAL[s.own]) out.push(`Твою запись не удалось получить с сервера: ${FETCH_REFUSAL[s.own]}.`);
  if (s.theirs === "waiting")
    out.push(
      s.synth
        ? `Ждём запись партнёра (${partner}): она отправляется сразу после песни. Пока её нет, звучит синтезированный голос; как только придёт, зазвучат настоящие голоса.`
        : `Ждём запись партнёра (${partner}): она отправляется сразу после песни; как только придёт, зазвучат настоящие голоса.`,
    );
  // Нет на сервере: не отправлена за срок или уже удалена (итог открыли через несколько минут).
  else if (s.theirs === "gone")
    out.push(`Записи партнёра (${partner}) на сервере нет: её не отправили в первые 90 секунд после песни, или она уже удалена — записи хранятся несколько минут.${s.synth ? " В строках партнёра звучит синтезированный голос." : ""}`);
  else if (s.theirs === "denied") out.push("Запись партнёра недоступна: согласие поделиться голосом снято, записи удалены с сервера.");
  else if (s.theirs === "timeout") out.push("Запись партнёра не удалось получить: сервер не отвечает. Проверь связь и нажми «Проверить ещё раз».");
  else if (s.theirs !== "ready" && FETCH_REFUSAL[s.theirs]) out.push(`Запись партнёра не удалось получить: ${FETCH_REFUSAL[s.theirs]}.`);
  return out;
}

const LAGS = "perepev.coopLags.";

/**
 * Задержки записей (из разбора линий) на время вкладки: после перезагрузки итога линий уже нет,
 * а записи ещё на сервере — без задержек голоса легли бы позже минуса. Хранятся только числа.
 */
export function rememberLags(matchId: string, lags: { mine: number; theirs: number }) {
  try {
    sessionStorage.setItem(LAGS + matchId, JSON.stringify(lags));
  } catch {
    /* хранилище недоступно: после перезагрузки задержки будут нулевыми */
  }
}

export function recallLags(matchId: string): { mine: number; theirs: number } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(LAGS + matchId) ?? "null") as { mine?: unknown; theirs?: unknown } | null;
    return v && typeof v.mine === "number" && typeof v.theirs === "number" ? { mine: v.mine, theirs: v.theirs } : null;
  } catch {
    return null;
  }
}

export interface MixVoice {
  samples: Float32Array;
  /** Задержка записи певца, с (из разбора его линии). */
  lag: number;
  pan: number;
}

/** Сведение: минус и оба голоса по времени песни, на одном AudioContext. */
export class VoiceMix {
  private nodes: AudioNode[] = [];
  private endTimer = 0;
  private closed = false;
  private startTime = 0;
  private ownsCtx = true;

  private constructor(
    private readonly ctx: AudioContext,
    private from: number,
    private readonly to: number,
  ) {}

  get position(): number {
    return this.positionAt(this.ctx.currentTime);
  }

  /** Когда звук начинается, по часам контекста. */
  get startsAt(): number {
    return this.startTime;
  }

  /** Место в песне в момент `t` часов контекста. */
  positionAt(t: number): number {
    return Math.min(this.to, Math.max(this.from, t - this.startTime + this.from));
  }

  /**
   * `ctx` — общий контекст прослушивания (см. CurveVoiceOptions.ctx): stop() его не закрывает.
   * `at` — старт по часам контекста (передача от синтезированного голоса с того же места).
   */
  static async play(o: { voices: MixVoice[]; backing: AudioBuffer | null; from: number; to: number; onEnd?: () => void; ctx?: AudioContext; at?: number }): Promise<VoiceMix> {
    // resume() до первого await: сохраняется активация от нажатия кнопки.
    const ctx = o.ctx ?? new AudioContext();
    const resumed = ctx.resume();
    const mix = new VoiceMix(ctx, o.from, o.to);
    mix.ownsCtx = !o.ctx;
    try {
      await resumed;
      const at = o.at === undefined ? ctx.currentTime + 0.08 : Math.max(o.at, ctx.currentTime + 0.01);
      // Старт сдвинулся позже запрошенного (сборка заняла больше запаса): песня продолжается с
      // того места, где будет в этот момент, а не повторяет пропущенное (минус не отступает назад).
      const from = Math.min(o.to, o.from + (o.at === undefined ? 0 : at - o.at));
      const length = Math.max(0.05, o.to - from);
      mix.startTime = at;
      mix.from = from;
      if (o.backing) {
        const src = ctx.createBufferSource();
        src.buffer = o.backing;
        const g = ctx.createGain();
        g.gain.value = 0.45;
        src.connect(g).connect(ctx.destination);
        src.start(at, from, length);
        mix.nodes.push(src, g);
      }
      for (const v of o.voices) {
        if (!v.samples.length) continue;
        const buffer = ctx.createBuffer(1, v.samples.length, RATE);
        // Ровная громкость записи, как у «Как пел» (level.ts).
        buffer.copyToChannel(normalizeRecording(v.samples, RATE), 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const pan = ctx.createStereoPanner();
        pan.pan.value = v.pan;
        src.connect(pan).connect(ctx.destination);
        const { delay, offset } = voiceStart(from, v.lag);
        if (offset < buffer.duration) src.start(at + delay, offset, Math.max(0.01, length - delay));
        mix.nodes.push(src, pan);
      }
      mix.endTimer = window.setTimeout(() => {
        mix.stop();
        o.onEnd?.();
      }, (at - ctx.currentTime + length + 0.15) * 1000);
      return mix;
    } catch (e) {
      mix.stop();
      throw e;
    }
  }

  stop(when?: number) {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.endTimer);
    silence(this.nodes, this.ctx, this.ownsCtx, when);
  }
}
