// Итог попытки: браузерный балл виден сразу с пометкой «предварительно». Окончательный приходит
// после проверки на компьютере команды; если тот выключен, не успел или связи нет, браузерный балл
// становится окончательным с пометкой «слова не проверены». В историю попадает окончательный.
import { poll, type PerfSession, type PlayMode, type PreciseResult } from "./uploader.ts";
import { saveAttempt } from "#lib/history.svelte.ts";
import type { ScoreResult, Song } from "#lib/scoring/types.ts";

/** Дольше 25 секунд после конца пения итог не ждём: досылка записи и опрос вместе. */
const LIMIT_MS = 25_000;

export const precise = $state<{ status: "pending" | "final" | "unchecked"; result: PreciseResult | null; mode: PlayMode; wordsCheck: boolean }>({
  status: "unchecked",
  result: null,
  mode: "headphones",
  wordsCheck: true,
});

/** Пометка, пока ждём итог: у песен без проверки слов («wordsCheck»: false) не обещаем проверку слов. */
export const pendingNote = (wordsCheck: boolean) => (wordsCheck ? "проверяем слова…" : "уточняем оценку…");

let ticket = 0;

/**
 * Показываемый итог: балл и оси сервера поверх браузерного разбора. Линия голоса, моменты
 * и задержка остаются браузерными, потому что относятся к записи, которая звучит при переслушивании.
 */
export function merged(local: ScoreResult, final: PreciseResult | null): ScoreResult {
  return final ? { ...local, score: final.score, axes: final.axes } : local;
}

/**
 * Следит за записью после конца пения; onFinal получает итог, сохранённый в истории.
 * mode — режим звука попытки: от него зависит совет при звуке из динамика.
 * wordsCheck — проверяет ли сервер слова этой песни (поле «wordsCheck» в index.json).
 */
export function settle(song: Song, provisional: ScoreResult, session: PerfSession | null, onFinal?: (result: ScoreResult) => void, mode: PlayMode = "headphones", wordsCheck = true) {
  const t = ++ticket;
  precise.status = session ? "pending" : "unchecked";
  precise.result = null;
  precise.mode = mode;
  precise.wordsCheck = wordsCheck;
  void (async () => {
    let final: PreciseResult | null = null;
    if (session) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), LIMIT_MS);
      try {
        const status = await poll(await session.finish(deadline.signal), deadline.signal);
        if (status.status === "done" && status.result) final = status.result;
      } catch {
        /* нет связи, отказ сервера или истёк срок: остаётся браузерный балл */
      }
      clearTimeout(timer);
    }
    const result = merged(provisional, final);
    if (t === ticket) {
      precise.status = final ? "final" : "unchecked";
      precise.result = final;
    }
    await saveAttempt(song, result, final ? { algorithm: final.algorithm, wordsChecked: final.wordsChecked === true } : null);
    onFinal?.(result);
  })();
}
