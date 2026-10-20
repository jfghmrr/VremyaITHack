<script lang="ts">
  // Правка распознанного текста своего трека: слова строк, сдвиг строки, начало и конец
  // по нажатию во время звучания. Сохраняет владелец (PUT /api/tracks/<id>/lyrics).
  import { onDestroy, onMount } from "svelte";
  import { page } from "$app/state";
  import { ApiError, api } from "#lib/api/http.ts";
  import { asset } from "#lib/catalog.ts";
  import { parseWordTiming, type WordTiming } from "#lib/lyrics.ts";
  import type { Song } from "#lib/scoring/types.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { saveLyrics, type OwnTrack } from "#lib/tracks/tracks.svelte.ts";
  import {
    NUDGE_S,
    TAP_REACTION_S,
    clockText,
    currentLine,
    insertLine,
    linesFrom,
    payload,
    problems,
    removeLine,
    retext,
    setLineEnd,
    setLineStart,
    shiftAll,
    shiftLine,
    type EditLine,
  } from "#lib/tracks/lyrics-edit.ts";

  const id = page.params.id ?? "";
  const songId = `my-${id}`;
  let title = $state("");
  let duration = $state(0);
  let lines = $state<EditLine[]>([]);
  let original: EditLine[] = [];
  let loading = $state(true);
  let fatal = $state("");
  let signIn = $state(false);
  let note = $state("");
  let error = $state("");
  let saved = $state("");
  let saving = $state(false);
  let dirty = $state(false);

  let audio = $state<HTMLAudioElement | null>(null);
  let audioUrl = "";
  let playing = $state(false);
  let time = $state(0);
  let stopAt = Infinity;
  let raf = 0;

  const now = $derived(currentLine(lines, time));
  const issue = $derived(problems(lines, duration));

  onMount(() => {
    void load();
    return () => cancelAnimationFrame(raf);
  });
  onDestroy(() => {
    audio?.pause();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });

  async function load() {
    try {
      const { tracks } = await api<{ tracks: OwnTrack[] }>("tracks");
      const track = tracks.find((t) => t.id === id);
      if (!track) throw new ApiError("Трек не найден или уже удалён.", 404);
      if (track.status !== "ready") throw new ApiError("Трек ещё обрабатывается: текст можно править, когда он будет готов.", 409);
      title = track.title;
      const response = await fetch(asset(songId, "reference.json"));
      if (!response.ok) throw new ApiError("Файлы трека не найдены. Возможно, он уже удалён.", response.status);
      const song: Song = await response.json();
      duration = song.duration_s;
      let timing: WordTiming | null = null;
      try {
        const words = await fetch(asset(songId, "lyrics.words.json"));
        if (words.ok) timing = parseWordTiming(await words.json(), song);
      } catch {
        /* Без разметки слов строки распределяются по их началам. */
      }
      lines = linesFrom(song, timing);
      original = lines;
      const mp3 = await fetch(asset(songId, "backing.mp3"));
      if (mp3.ok) {
        // Из Blob звук перематывается в любое место, даже если сервер не отдаёт диапазоны.
        audioUrl = URL.createObjectURL(await mp3.blob());
        const a = new Audio(audioUrl);
        a.preload = "auto";
        a.onended = () => pause();
        audio = a;
      } else note = "Звук трека не загрузился: время можно поправить только кнопками.";
    } catch (e) {
      signIn = e instanceof ApiError && e.status === 401;
      fatal = signIn ? "Войди, чтобы править свои треки." : (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function frame() {
    if (!audio) return;
    time = audio.currentTime;
    if (time >= stopAt) {
      pause();
      return;
    }
    if (playing) raf = requestAnimationFrame(frame);
  }

  async function play(from?: number, to = Infinity) {
    if (!audio) return;
    if (from !== undefined) audio.currentTime = Math.max(0, from);
    stopAt = to;
    try {
      await audio.play();
    } catch {
      note = "Браузер не дал включить звук. Нажми «Слушать» ещё раз.";
      return;
    }
    playing = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function pause() {
    audio?.pause();
    playing = false;
    stopAt = Infinity;
    cancelAnimationFrame(raf);
    if (audio) time = audio.currentTime;
  }

  function seek(t: number) {
    if (!audio) return;
    audio.currentTime = Math.min(duration, Math.max(0, t));
    time = audio.currentTime;
  }

  /** Момент нажатия: во время звучания — с поправкой на время реакции. */
  const tapTime = () => Math.max(0, (audio?.currentTime ?? time) - (playing ? TAP_REACTION_S : 0));

  function apply(next: EditLine[] | null, refusal: string) {
    error = "";
    saved = "";
    if (!next) {
      note = refusal;
      return;
    }
    note = "";
    lines = next;
    dirty = true;
  }

  const NO_ROOM = "Здесь нет места: строка упирается в соседнюю или в край отрывка.";

  function commitText(i: number, text: string) {
    if (text === lines[i].text && lines[i].words.length) return;
    apply(lines.map((l, k) => (k === i ? retext(l, text) : l)), "");
  }

  function addLine() {
    const result = insertLine(lines, tapTime(), duration);
    apply(result?.lines ?? null, "Здесь нет паузы для новой строки. Перемотай туда, где никто не поёт.");
    if (result) requestAnimationFrame(() => document.getElementById(`line-${result.lines[result.index].key}`)?.focus());
  }

  async function save() {
    if (issue) {
      error = issue;
      return;
    }
    saving = true;
    error = "";
    saved = "";
    try {
      const result = await saveLyrics(id, payload(lines));
      // Сервер маскирует мат: показываем сохранённый текст.
      lines = lines.map((l, i) => {
        const words = result.lines[i]?.words;
        return words ? { ...l, words, text: words.map((w) => w.text).join(" ") } : l;
      });
      original = lines;
      dirty = false;
      saved = result.masked ? "Сохранено. Грубые слова скрыты звёздочками." : "Сохранено.";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  function reset() {
    lines = original;
    dirty = false;
    note = "";
    error = "";
    saved = "";
  }
</script>

<svelte:head><title>Текст и тайминги — Перепев</title></svelte:head>

<section class="editor" aria-labelledby="editor-title">
  <a class="back" href="/songs#my-tracks">← Мои треки</a>
  <h1 id="editor-title">Текст и тайминги</h1>
  {#if title}<p class="track-title">{title}</p>{/if}

  {#if loading}
    <p class="notice" role="status">Загружаем текст трека…</p>
  {:else if fatal}
    <p class="notice error" role="alert">{fatal}{#if signIn}&nbsp;<a href={signInHref(`/tracks/${id}/lyrics`)}>Войти</a>{/if}</p>
  {:else}
    <div class="player sheet">
      <div class="transport">
        <button type="button" class="btn btn-ink" disabled={!audio} onclick={() => (playing ? pause() : play())}>{playing ? "Пауза" : "Слушать"}</button>
        <span class="clock mono" aria-live="off">{clockText(time)} / {clockText(duration)}</span>
      </div>
      <label class="field position">
        <span class="visually-hidden">Позиция</span>
        <input type="range" min="0" max={duration} step="0.1" value={time} disabled={!audio} oninput={(e) => seek(Number(e.currentTarget.value))} />
      </label>
      <div class="all">
        <span>Все строки:</span>
        <button type="button" class="btn" onclick={() => apply(shiftAll(lines, -NUDGE_S, duration), NO_ROOM)}>−0,1 с</button>
        <button type="button" class="btn" onclick={() => apply(shiftAll(lines, NUDGE_S, duration), NO_ROOM)}>+0,1 с</button>
        <button type="button" class="btn" onclick={addLine}>Добавить строку в {clockText(time)}</button>
      </div>
    </div>

    <p class="hint">
      Исправь слова и нажми Enter. Чтобы поправить время, включи звук и нажми «Начало здесь» в тот момент, когда строка начинает звучать, или сдвигай её по 0,1 с.
      Времена слов внутри строки подстроятся сами.
    </p>

    {#if !lines.length}<p class="notice">Слов не нашлось. Добавь строку в нужном месте трека.</p>{/if}
    <ol class="lines">
      {#each lines as line, i (line.key)}
        <li class="line sheet" class:now={playing && now === i} class:empty={!line.words.length}>
          <div class="row">
            <span class="num mono">{i + 1}</span>
            <span class="range mono">{clockText(line.start)}–{clockText(line.end)}</span>
            <button type="button" class="btn btn-quiet" disabled={!audio} aria-label="Слушать строку {i + 1}" onclick={() => play(line.start - 0.3, line.end + 0.3)}>▶ Слушать</button>
            <button type="button" class="btn btn-quiet remove" aria-label="Удалить строку {i + 1}" onclick={() => apply(removeLine(lines, i), "")}>Удалить</button>
          </div>
          <label class="field text">
            <span class="visually-hidden">Строка {i + 1}</span>
            <input id="line-{line.key}" value={line.text} maxlength="400" autocomplete="off" spellcheck="true" placeholder="Слова строки" onchange={(e) => commitText(i, e.currentTarget.value)} />
          </label>
          {#if line.words.length}
            <p class="words" aria-hidden="true">
              {#each line.words as word}<span class:on={playing && time >= word.start_s && time < word.end_s}>{word.text}</span>{" "}{/each}
            </p>
          {/if}
          <div class="row moves">
            <button type="button" class="btn" aria-label="Строку {i + 1} раньше на 0,1 с" onclick={() => apply(shiftLine(lines, i, -NUDGE_S, duration), NO_ROOM)}>−0,1 с</button>
            <button type="button" class="btn" aria-label="Строку {i + 1} позже на 0,1 с" onclick={() => apply(shiftLine(lines, i, NUDGE_S, duration), NO_ROOM)}>+0,1 с</button>
            <button type="button" class="btn" aria-label="Начало строки {i + 1} здесь" onclick={() => apply(setLineStart(lines, i, tapTime(), duration), NO_ROOM)}>Начало здесь</button>
            <button type="button" class="btn" aria-label="Конец строки {i + 1} здесь" onclick={() => apply(setLineEnd(lines, i, tapTime(), duration), NO_ROOM)}>Конец здесь</button>
          </div>
        </li>
      {/each}
    </ol>

    <div class="actions sheet">
      {#if note}<p class="notice" role="status">{note}</p>{/if}
      {#if error}<p class="notice error" role="alert">{error}</p>{/if}
      {#if saved}<p class="notice" role="status">{saved} <a href="/sing/{songId}">Петь</a></p>{/if}
      {#if dirty && !saved && !error}<p class="small muted">Есть несохранённые правки.</p>{/if}
      <div class="row">
        <button type="button" class="btn btn-primary" disabled={saving || !dirty} onclick={save}>{saving ? "Сохраняем…" : "Сохранить"}</button>
        <button type="button" class="btn btn-quiet" disabled={saving || !dirty} onclick={reset}>Вернуть как было</button>
        <a class="btn btn-quiet" href="/sing/{songId}">Петь</a>
      </div>
    </div>
  {/if}
</section>

<style>
  .editor {
    display: grid;
    gap: var(--s-4);
    width: min(100%, 920px);
    margin: 0 auto;
    padding: var(--s-6) var(--gutter) var(--s-7);
    color: var(--on-room);
  }
  .back {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--on-room-2);
  }
  h1 {
    margin: 0;
    font: 700 2.6rem/1 var(--font-hand);
  }
  .track-title {
    margin: 0;
    color: var(--on-room-2);
    overflow-wrap: anywhere;
  }
  .hint {
    margin: 0;
    color: var(--on-room-2);
    font-size: var(--t-s);
  }
  .player {
    position: sticky;
    top: var(--s-2);
    z-index: 2;
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
  }
  .transport,
  .all,
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-3);
  }
  .clock {
    font-size: var(--t-m);
  }
  .position input {
    width: 100%;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    accent-color: var(--accent);
  }
  .all span {
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  .btn {
    min-height: 44px;
  }
  .lines {
    display: grid;
    gap: var(--s-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .line {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-left: 4px solid transparent;
  }
  .line.now {
    border-left-color: var(--accent);
    background-color: #fff8e6;
  }
  .line.empty {
    border-left-color: var(--mustard);
  }
  .num {
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    font-size: var(--t-xs);
  }
  .range {
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  .remove {
    margin-left: auto;
    color: var(--accent);
  }
  .text input {
    width: 100%;
    min-height: 44px;
    font-size: var(--t-l);
  }
  .words {
    margin: 0;
    font-size: var(--t-s);
    color: var(--ink-3);
  }
  .words .on {
    color: var(--accent);
    font-weight: 700;
  }
  .moves .btn {
    font-size: var(--t-s);
  }
  .actions {
    position: sticky;
    bottom: var(--s-2);
    z-index: 2;
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
  }
  .actions p {
    margin: 0;
  }
  /* На телефоне и в низком окне закреплённые панели заняли бы половину экрана. */
  @media (max-width: 599px), (max-height: 520px) {
    .player,
    .actions {
      position: static;
    }
  }
  @media (max-width: 599px) {
    .editor {
      padding: var(--s-4) 16px var(--s-6);
    }
    h1 {
      font-size: 2.2rem;
    }
    .line,
    .player,
    .actions {
      padding: var(--s-3);
    }
    .moves {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .actions .row .btn {
      flex: 1 1 auto;
    }
  }
  /* Телефон (PHONE_QUERY): «← Мои треки» — стрелка в шапке; панель «Сохранить» (закреплена на
     узком планшете в портрете) стоит над нижним меню, а не под ним. */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .back {
      display: none;
    }
    .actions {
      bottom: calc(var(--bar-space, 0px) + var(--s-2));
    }
  }
</style>
