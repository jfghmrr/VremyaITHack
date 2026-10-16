<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { command, connect, live } from "#lib/live/client.svelte.ts";
  import { loadCatalog } from "#lib/catalog.ts";
  import type { SongInfo } from "#lib/api/types.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Star from "#lib/brand/Star.svelte";

  let songs = $state<SongInfo[]>([]);
  let song = $state("");
  let error = $state("");
  let now = $state(Date.now());

  onMount(() => {
    loadCatalog().then((l) => ((songs = l), (song ||= l[0]?.id ?? ""))).catch(() => {});
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    if (account.profile) connect();
  });

  $effect(() => {
    const id = live.queue?.match_id ?? (live.match && !["finished", "cancelled", "failed"].includes(live.match.state) ? live.match.match_id : null);
    if (id) void goto(`/duels/match/${id}`);
    else if (live.room && (!live.match || !["finished", "cancelled", "failed"].includes(live.match.state))) void goto(`/duels/room/${live.room.code}`);
  });

  const searching = $derived(live.queue?.status === "searching");
  const waited = $derived(searching && live.queue?.since_ms ? Math.max(0, Math.floor((now - live.queue.since_ms) / 1000)) : 0);

  async function find() {
    error = "";
    const r = await command({ type: "queue_join" });
    if (!r.ok) error = r.error ?? "Не удалось начать поиск.";
  }
  async function cancel() {
    await command({ type: "queue_leave" });
  }
  async function room() {
    error = "";
    const r = await command({ type: "room_create", song_id: song });
    if (!r.ok) error = r.error ?? "Не удалось создать комнату.";
  }
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
</script>

<svelte:head><title>Дуэли — Перепев</title></svelte:head>

<div class="duels">
  <header>
    <TitleStrip text="Дуэли" fastener="paperclip" />
    <p class="lead">Двое поют одну мелодию, каждый в своей тональности. Побеждает точность.</p>
    <a class="btn" href="/friends">Друзья и заявки →</a>
  </header>
  <div class="body">

  {#if account.loaded && !account.profile}
    <p class="notice">Для живых дуэлей нужен кабинет: результат и рейтинг сохраняются на сервере. <a href={signInHref("/duels")}>Войти или зарегистрироваться</a></p>
  {/if}
  {#if error || live.error}<p class="notice error" role="alert">{error || live.error}</p>{/if}
  {#if account.profile && live.status === "reconnecting"}<p class="notice" role="status">Восстанавливаем соединение…</p>{/if}

  <ol class="modes">
    <li class="mode poster" class:active={searching}>
      <span class="badge" aria-hidden="true"><Star variant="print" size={54} /></span>
      <div class="text">
        <h2>Найти соперника</h2>
        <p>Рейтинговый матч с игроком близкого уровня. Фрагмент сервер выбирает после подбора из общего набора: реже сыгранный вами обоими.</p>
        {#if searching && live.queue}
          <div class="search" role="status">
            <div>
              <b><span class="lamp" aria-hidden="true">ЗАПИСЬ</span> Ищем соперника, <span class="mono">{clock(waited)}</span></b>
              <p class="small">
                {live.queue.pool === "cal" ? "Пул калибровки: игроки, которые тоже проходят первые матчи." : "Основной пул."}
                Допустимая разница уровня сейчас ±{Math.round(live.queue.window ?? 0)} MMR, она медленно расширяется до предела.
              </p>
              {#if waited >= 30}
                <p class="small">Пока никто не подходит. Можно ждать дальше, позвать друга или спеть с призраком: ботов вместо людей здесь нет.</p>
              {/if}
            </div>
            <button class="btn" onclick={cancel}>Отменить поиск</button>
          </div>
        {/if}
      </div>
      {#if !searching}
        <button class="btn btn-ink big" disabled={!account.profile || live.status !== "open"} onclick={find}>Найти соперника</button>
      {/if}
    </li>
    <li class="mode ticket">
      <span class="stub mono" aria-hidden="true">вход на двоих</span>
      <div class="text">
        <h2>Играть с другом</h2>
        <p>Комната по ссылке: вы оба подтверждаете готовность и поёте одновременно. Рейтинг не меняется.</p>
      </div>
      <div class="room">
        <label class="field"><span class="visually-hidden">Песня</span>
          <select bind:value={song}>{#each songs as s (s.id)}<option value={s.id}>{s.title}</option>{/each}</select>
        </label>
        <button class="btn" disabled={!account.profile || live.status !== "open" || searching} onclick={room}>Создать комнату</button>
      </div>
    </li>
    <li class="mode kraft">
      <span class="tape" style:left="18px" style:top="-12px" style:rotate="-6deg" aria-hidden="true"></span>
      <div class="text">
        <h2>Вызов-призрак</h2>
        <p>Спой песню и отправь ссылку с линией своего пения, без звука. Друг поёт, когда удобно, и видит твою линию пунктиром.</p>
      </div>
      <a class="btn" href="/songs">Выбрать песню</a>
    </li>
  </ol>
  </div>
</div>

<style>
  .duels {
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 8fr);
    gap: var(--s-8);
    align-items: start;
    padding-top: clamp(var(--s-2), 3vh, var(--s-7));
  }
  header {
    display: grid;
    gap: var(--s-4);
    justify-items: start;
    position: sticky;
    top: var(--s-5);
  }
  .lead {
    font-size: var(--t-l);
    color: var(--on-room-2);
    max-width: 30ch;
  }
  .body {
    min-width: 0;
    display: grid;
    gap: var(--s-4);
  }
  .modes {
    display: grid;
    gap: var(--s-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Три режима — три разных предмета: афиша, билет и крафтовая записка. */
  .mode {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: var(--s-3) var(--s-6);
    padding: var(--s-4) var(--s-6);
    box-shadow: var(--shadow-sheet);
  }
  .mode.active {
    grid-template-columns: 1fr;
  }
  .text {
    min-width: 0;
    display: grid;
    gap: var(--s-2);
    max-width: 60ch;
  }
  h2 {
    font-size: var(--t-2xl);
    letter-spacing: -0.01em;
  }
  .text p {
    font-size: var(--t-m);
  }
  .poster {
    background: var(--accent) var(--tex-paper);
    color: var(--paper-2);
  }
  .poster h2 {
    font-family: var(--font-poster);
    font-size: 2.1rem;
    font-weight: 700;
    letter-spacing: 0;
  }
  .poster .text > p {
    color: #f3d9d2;
  }
  .badge {
    position: absolute;
    top: -16px;
    right: -14px;
    transform: rotate(14deg);
  }
  .big {
    min-height: var(--control-h-l);
    padding: 0 var(--s-5);
    font-size: var(--t-l);
  }
  .search {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--s-4);
    align-items: start;
    margin-top: var(--s-3);
    padding: var(--s-4);
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
  }
  .search div {
    display: grid;
    gap: var(--s-1);
  }
  .search .small {
    color: var(--ink-2);
  }
  /* Лампа записи на деке мигает, пока идёт поиск. Стоит в строке заголовка, а не отдельной
     колонкой: «ЗАПИСЬ» шире «REC» и иначе сужала бы текст поиска на лишнюю строку. */
  .lamp {
    display: inline-block;
    margin-right: var(--s-1);
    padding: 0 6px;
    line-height: 1.5;
    vertical-align: 1px;
    white-space: nowrap;
    border-radius: 2px;
    background: var(--accent);
    color: var(--paper-2);
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    animation: lamp 1.6s ease-in-out infinite;
  }
  @keyframes lamp {
    50% {
      opacity: 0.35;
    }
  }
  .ticket {
    grid-template-columns: auto 1fr;
    padding-left: 0;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    mask: radial-gradient(circle 9px at 0 50%, transparent 97%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle 9px at 100% 50%, transparent 97%, #000) right / 51% 100% no-repeat;
  }
  .ticket .text p {
    color: var(--ink-2);
  }
  .stub {
    grid-row: span 2;
    align-self: stretch;
    display: grid;
    place-items: center;
    width: 44px;
    border-right: 2px dashed var(--line-strong);
    color: var(--accent);
    font-size: var(--t-xs);
    writing-mode: vertical-rl;
    transform: rotate(180deg);
  }
  .room {
    grid-column: 2;
    display: flex;
    gap: var(--s-3);
    align-items: center;
  }
  .room .field {
    flex: 0 1 260px;
    min-width: 0;
  }
  .room select {
    width: 100%;
  }
  .kraft {
    background: var(--kraft) var(--tex-paper);
    color: var(--ink);
  }
  .kraft h2 {
    font-family: var(--font-hand);
    font-size: 2.2rem;
    font-weight: 700;
    letter-spacing: 0;
  }
  .kraft h2::after {
    content: "";
    display: block;
    width: 9rem;
    height: 3px;
    margin-top: 2px;
    background: repeating-linear-gradient(90deg, var(--rival) 0 8px, transparent 8px 13px);
  }
  .kraft .text p {
    color: #3b342b;
  }
  /* Сенсорный экран или не wide: ссылка входа не ниже 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .notice a {
      display: inline-flex;
      align-items: center;
      min-height: var(--tap);
    }
  }
  /* Не wide: заголовок над карточками режимов. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .duels {
      grid-template-columns: 1fr;
      gap: var(--s-5);
    }
    header {
      position: static;
    }
  }
  /* compact: карточки режимов в одну колонку. */
  @media (max-width: 599px) {
    .badge { right: 5px; }
    .search { grid-template-columns: 1fr; }
    .room { min-width: 0; max-width: 100%; }
    .room .field { flex-basis: 100%; }
    .mode { padding: 16px 20px; }
    .mode,
    .ticket {
      grid-template-columns: 1fr;
    }
    .ticket {
      padding-left: var(--s-6);
    }
    .stub {
      display: none;
    }
    .room {
      grid-column: 1;
    }
    .room {
      flex-wrap: wrap;
    }
  }
</style>
