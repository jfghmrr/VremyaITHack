<script lang="ts">
  import { goto } from "$app/navigation";
  import { signInHref } from "#lib/auth/return.ts";
  import { onMount, tick } from "svelte";
  import Cover from "#lib/ui/Cover.svelte";
  import Cassette from "#lib/brand/Cassette.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Pin from "#lib/brand/Pin.svelte";
  import { asset, loadCatalog, filterCatalog, catalogSections, type CatalogEntry, type CatalogSection } from "#lib/catalog.ts";
  import { incoming, last } from "#lib/session.svelte.ts";
  import IncomingChallenge from "#lib/ui/IncomingChallenge.svelte";
  import { reducedMotion } from "#lib/ui/canvas.ts";
  import AgeBadge from "#lib/legal/AgeBadge.svelte";
  import MyTracks from "#lib/tracks/MyTracks.svelte";
  import { account } from "#lib/api/account.svelte.ts";

  let songs = $state<CatalogEntry[]>([]);
  let selected = $state("");
  let section = $state<CatalogSection>("Все");
  let query = $state("");
  let error = $state("");
  let loading = $state(true);
  let playing = $state<string | null>(null);
  let audio: HTMLAudioElement | null = null;
  let strip: HTMLFieldSetElement;
  let search: HTMLInputElement;

  const visible = $derived(filterCatalog(songs, section, query));

  const chosen = $derived(visible.find((s) => s.id === selected));

  $effect(() => {
    if (visible.length && !visible.some(s => s.id === selected)) selected = visible[0].id;
  });

  onMount(() => {
    loadCatalog()
      .then((list) => {
        songs = list;
        selected ||= list[0]?.id ?? "";
      })
      .catch((e: Error) => (error = e.message))
      .finally(() => (loading = false));
    const focusSearch = () => {
      if (location.hash === "#search") search?.focus({ preventScroll: true });
    };
    focusSearch();
    addEventListener("hashchange", focusSearch);
    return () => { audio?.pause(); removeEventListener("hashchange", focusSearch); };
  });

  $effect(() => {
    if (playing && !visible.some((song) => song.id === playing)) {
      audio?.pause();
      playing = null;
    }
  });

  // Выбранный полароид всегда в центре ленты.
  $effect(() => {
    const id = selected;
    void visible.length;
    void tick().then(() => {
      const el = strip?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      if (el && strip) {
        const dx = el.getBoundingClientRect().left - strip.getBoundingClientRect().left;
        strip.scrollTo({ left: strip.scrollLeft + dx - (strip.clientWidth - el.clientWidth) / 2, behavior: reducedMotion() ? "auto" : "smooth" });
      }
    });
  });

  function step(dir: -1 | 1) {
    const i = visible.findIndex((s) => s.id === selected);
    const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    if (next) selected = next.id;
  }

  async function listen(song: CatalogEntry) {
    if (!song.preview) return;
    if (playing === song.id) {
      audio?.pause();
      playing = null;
      return;
    }
    audio?.pause();
    const next = new Audio(asset(song.id, song.preview));
    audio = next;
    error = "";
    next.onended = () => { if (audio === next) playing = null; };
    next.onerror = () => {
      if (audio !== next) return;
      playing = null;
      error = "Не удалось загрузить запись. Проверь соединение и попробуй ещё раз.";
    };
    try {
      await next.play();
      if (audio === next) playing = song.id;
    } catch {
      if (audio === next) error = "Не удалось воспроизвести запись. Проверь звук и попробуй ещё раз.";
    }
  }

  const seconds = (s: number) => `${Math.round(s)} сек`;
</script>

<svelte:head><title>Выбор песни — Перепев</title></svelte:head>

<IncomingChallenge />

<!-- Расстановка повторяет мокап «Выбор песни». -->
<section class="scene pick" aria-labelledby="pick-title">
  <div class="at title" style:--x="2%" style:--y="3%">
    <TitleStrip text="Выбор песни" id="pick-title" pin />
    <span class="scribble deco" aria-hidden="true"></span>
  </div>
  {#if last.result}
    <a class="at resume" style:--x="66%" style:--y="5%" href="/result">
      <span class="stub mono" aria-hidden="true">{Math.round(last.result.score)}</span>
      <span>Последний разбор: <b>{last.song?.title}</b>, {last.result.score.toFixed(1)}</span>
      <span class="resume-go">Вернуться</span>
    </a>
  {/if}

  <div class="at sections" style:--x="8%" style:--y="19%" style:--w="58%" role="group" aria-label="Раздел каталога">
    {#each catalogSections as name (name)}
      <button type="button" aria-pressed={section === name} onclick={() => (section = name)}>{name}</button>
    {/each}
  </div>
  <label class="at search" style:--x="70%" style:--y="18.5%" style:--w="22%">
    <span class="visually-hidden">Поиск песни</span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>
    <input id="search" type="search" bind:this={search} bind:value={query} placeholder="Поиск…" autocomplete="off" />
  </label>

  <p class="at catalog-status" style:--x="8%" style:--y="25.5%" aria-live="polite">{loading ? "Загружаем каталог…" : `${visible.length} фрагментов`}{#if !loading} · Выбери, послушай и подпевай{/if}{#if account.profile} · <a href="#my-tracks">Мои треки ↓</a>{:else if account.loaded} · <a href={signInHref("/songs#my-tracks")}>Свой трек — после входа</a>{/if}</p>
  {#if error}<p class="at notice error catalog-error" style:--x="8%" style:--y="30%" role="alert">{error}<button type="button" onclick={() => error = ""} aria-label="Закрыть ошибку">×</button></p>{/if}

  <div class="at carousel" style:--x="3%" style:--y="27%" style:--w="94%">
    <button type="button" class="arrow" aria-label="Предыдущая песня" disabled={!visible.length || visible[0]?.id === selected} onclick={() => step(-1)}>‹</button>
    <fieldset class="songs" aria-label="Песни" bind:this={strip}>
      <legend class="visually-hidden">Песня, {visible.length} в разделе «{section}»</legend>
      {#each visible as song, i (song.id)}
        <label class="song" class:checked={selected === song.id} data-id={song.id} style:--tilt="{i % 2 ? 1.6 : -1.4}deg">
          <input type="radio" name="song" value={song.id} bind:group={selected} />
          <span class="cover"><Cover id={song.id} title={song.title} contour={song.contour} /></span>
          <span class="caption">
            <span class="title">{song.title}</span>
            <span class="artist">{song.artist}</span>
            <span class="vocal-label">{song.hasVocals ? `${song.language === "ru" ? "RU" : "EN"} · Голос + слова` : song.wordTiming ? "Мелодия + текст" : "Мелодия на «ла»"}</span>
            <span class="meta">
              <span class="mono dur">{seconds(song.duration_s)} <AgeBadge age={song.age ?? "0+"} /></span>
              {#if song.preview}
                <button type="button" class="listen" aria-label="{playing === song.id ? 'Остановить' : 'Послушать'} «{song.title}»" aria-pressed={playing === song.id} onclick={(e) => { e.preventDefault(); void listen(song); }}>
                  <span aria-hidden="true">{playing === song.id ? "■" : "▶"}</span>
                  {playing === song.id ? "Стоп" : "Послушать"}
                </button>
              {/if}
            </span>
          </span>
        </label>
      {:else}
        {#if !loading && !error}<p class="none">Ничего не нашлось. Попробуй другое слово или раздел.</p>{/if}
      {/each}
    </fieldset>
    <button type="button" class="arrow" aria-label="Следующая песня" disabled={!visible.length || visible.at(-1)?.id === selected} onclick={() => step(1)}>›</button>
  </div>

  <div class="at deck" style:--x="12%" style:--y="76%" style:--w="76%">
    <div class="slot">
      {#if chosen}
        <Cassette label="Перепев" note={seconds(chosen.duration_s)} tone={playing === chosen.id ? "red" : "black"} spinning={playing === chosen.id} width={110} />
      {/if}
      <div class="label-strip"><strong>{chosen?.title ?? "Выбери песню"}</strong>{#if chosen}<span>{chosen.artist.split(" · ")[0]} · {seconds(chosen.duration_s)}{#if chosen.license} · <a href={`/legal/music#${chosen.id}`}>{chosen.license} ↗</a>{/if}</span>{/if}</div>
    </div>
    <!-- При входящем вызове основное действие — принять его; выбор песни остаётся второстепенным. -->
    <button class="btn choose" class:btn-primary={!incoming.challenge} disabled={!chosen} aria-label={chosen ? `Петь «${chosen.title}»` : "Петь"} onclick={() => chosen && goto(`/sing/${chosen.id}`)}>
      Петь →
    </button>
  </div>
  <span class="at guide-cat" style:--x="86%" style:--y="63%" style:--w="7%" aria-hidden="true"><Cat mood="listening" size="100%" /></span>

  <span class="at deco" style:--x="3%" style:--y="70%" style:--w="3.4%" style:--r="-10deg"><Pin kind="note" size="100%" /></span>
  <span class="at deco" style:--x="60%" style:--y="2%" style:--w="2.4%" style:--r="14deg"><Pin kind="note" size="100%" /></span>
</section>

{#if account.profile}<MyTracks />{/if}

<style>
  .catalog-status { margin: 0; font-size: 12px; color: var(--on-room-2); }
  .catalog-error { z-index: 5; display: flex; gap: 16px; align-items: center; max-width: 84%; }
  .catalog-error button { background: transparent; border: 0; color: inherit; cursor: pointer; font-size: 24px; }
  .vocal-label { font-size: 10px; color: var(--accent); font-weight: 650; margin-top: 4px; }
  .label-strip a { color: var(--accent); text-underline-offset: 2px; }
  .resume {
    display: inline-flex;
    align-items: stretch;
    gap: var(--s-3);
    padding-right: var(--s-3);
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    font-size: var(--t-s);
    text-decoration: none;
    transform: rotate(0.8deg);
    box-shadow: var(--shadow-sticker);
  }
  .resume > span {
    align-self: center;
  }
  .stub {
    display: grid;
    place-items: center;
    padding: 6px 10px;
    border-right: 2px dashed var(--line-strong);
    color: var(--accent);
    font-size: var(--t-xs);
  }
  .resume-go {
    font-weight: 700;
    color: var(--accent);
    text-decoration: underline;
  }

  .title {
    display: flex;
    align-items: center;
    gap: var(--s-4);
  }
  .scribble {
    width: 60px;
    height: 26px;
    background:
      linear-gradient(-12deg, transparent 45%, var(--paper) 45% 52%, transparent 52%) 0 0 / 100% 33%,
      linear-gradient(-6deg, transparent 45%, var(--paper) 45% 52%, transparent 52%) 0 50% / 100% 33% no-repeat;
    opacity: 0.8;
  }
  .sections {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sections button {
    min-height: 32px;
    padding: 0 var(--s-3);
    border: 1px solid #0d0c0d;
    border-radius: 2px;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    font-size: var(--t-s);
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 0 rgb(0 0 0 / 0.45);
    transition: transform var(--d-fast) var(--ease);
  }
  .sections button:hover {
    transform: translateY(-1px);
  }
  .sections button:active {
    transform: translateY(2px);
    box-shadow: none;
  }
  .sections [aria-pressed="true"] {
    background-color: var(--accent);
    color: var(--paper-2);
    box-shadow: inset 0 2px 3px rgb(0 0 0 / 0.35);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: min(100%, 260px);
    min-height: 34px;
    padding: 0 var(--s-3);
    border: 2px solid #0d0c0d;
    border-radius: 999px;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
  }
  .search:focus-within {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  .search svg {
    flex: none;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font-size: var(--t-s);
    outline: none;
  }

  /* Лента полароидов: выбранный в центре, крупнее и ровно; соседние выглядывают по краям. */
  .carousel {
    --card-width: min(26cqi, 27svh);
    --card-gap: clamp(32px, 4cqi, 64px);
    left: 50%;
    transform: translateX(-50%);
    width: min(94%, calc(var(--card-width) * 3 + var(--card-gap) * 2 + 144px));
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-2);
    height: 47%;
  }
  .arrow {
    width: 40px;
    height: 64px;
    border: 0;
    background: none;
    color: var(--on-room);
    font-size: 3.2rem;
    line-height: 1;
    cursor: pointer;
    transition: transform var(--d-fast) var(--ease);
  }
  .arrow:hover:not(:disabled) {
    transform: scale(1.12);
  }
  .arrow:disabled {
    color: var(--room-line);
    cursor: default;
  }
  .songs {
    --card-width: min(26cqi, 27svh);
    --card-gap: clamp(32px, 4cqi, 64px);
    display: flex;
    align-items: center;
    gap: var(--card-gap);
    height: 100%;
    min-width: 0;
    margin: 0;
    padding: 20px 24px;
    border: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    mask-image: linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent);
  }
  .song {
    position: relative;
    flex: none;
    display: grid;
    width: var(--card-width);
    max-width: 320px;
    padding: 11px 11px 8px;
    background: #f3eee3 var(--tex-paper);
    color: var(--ink);
    cursor: pointer;
    scroll-snap-align: center;
    box-shadow:
      0 2px 2px rgb(0 0 0 / 0.5),
      0 18px 26px -14px rgb(0 0 0 / 0.95);
    transform: rotate(var(--tilt)) scale(0.94);
    transition:
      transform var(--d-base) var(--ease-heavy),
      box-shadow var(--d-base) var(--ease);
  }
  .song input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .cover {
    display: block;
    container-type: inline-size;
    --cover-fs: 14cqi;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
  }
  .caption {
    display: grid;
    gap: 1px;
    padding: 8px 2px 0;
  }
  .title {
    font-weight: 700;
    font-size: var(--t-s);
    line-height: 1.2;
  }
  .artist {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.75rem;
    line-height: 1.25;
    color: var(--ink-2);
  }
  .meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 2px;
    font-size: 0.72rem;
    color: var(--ink-2);
  }
  .dur {
    white-space: nowrap;
  }
  .listen {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 26px;
    margin-right: -6px;
    padding: 0 6px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--ink);
    font-size: 0.72rem;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .listen:hover {
    background: rgb(0 0 0 / 0.07);
  }
  .listen[aria-pressed="true"] {
    color: var(--accent);
  }
  .song:hover {
    transform: rotate(0) scale(0.95) translateY(-4px);
  }
  .song.checked {
    z-index: 1;
    transform: rotate(0) scale(1.015);
    box-shadow:
      0 0 0 3px var(--accent),
      0 4px 4px rgb(0 0 0 / 0.5),
      0 30px 40px -16px rgb(0 0 0 / 1);
  }
  .song.checked::after {
    content: "";
    position: absolute;
    top: -9px;
    left: 50%;
    width: 70px;
    height: 20px;
    background: rgb(232 226 205 / 0.6);
    transform: translateX(-50%) rotate(-3deg);
  }
  .song:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 4px;
  }
  .none {
    margin: auto;
    color: var(--on-room-2);
  }

  .deck {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s-5);
    padding: 10px var(--s-5) 10px 12px;
    border: 3px solid #0d0c0d;
    border-radius: 12px;
    background:
      linear-gradient(rgb(255 255 255 / 0.07), transparent 40%),
      var(--tex-metal),
      #2a292b;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.14),
      var(--shadow-object);
  }
  .slot {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--s-4);
    min-height: 94px;
    padding: 6px 14px;
    border-radius: 6px;
    background: #121112;
    box-shadow: inset 0 3px 8px rgb(0 0 0 / 0.8);
    overflow: hidden;
  }
  .label-strip { min-width: 0; flex: 1; padding: 9px 14px; background: var(--paper) var(--tex-paper); color: var(--ink); border-bottom: 4px solid var(--accent); }
  .label-strip strong { display: block; font: 700 clamp(20px,2cqi,30px)/1.1 var(--font-hand); overflow-wrap: anywhere; }
  .label-strip span { display: block; margin-top: 4px; font-size: 12px; line-height: 1.3; }
  .caption > .title { display: block; overflow-wrap: anywhere; }
  .choose {
    min-width: 132px;
  }
  /* Сенсорный экран или не wide: цели нажатия не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .sections button,
    .resume {
      min-height: var(--tap);
    }
    /* Карточка ленты уменьшена (scale 0.94): 48 px дают на экране не меньше 44. */
    .listen {
      min-height: 48px;
    }
    /* Поле поиска во всю высоту капсулы: цель нажатия 44 px внутри рамки. */
    .search {
      min-height: calc(var(--tap) + 4px);
    }
    .search input {
      align-self: stretch;
    }
    .arrow {
      width: var(--tap);
    }
    .catalog-error button {
      min-width: var(--tap);
      min-height: var(--tap);
    }
  }
  /* Не wide: каталог идёт потоком, лента полароидов на всю ширину. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .carousel,
    .deck {
      width: 100%;
    }
    .carousel {
      left: auto;
      transform: none;
      height: 360px;
    }
    .songs {
      padding-inline: 24px;
    }
    .song {
      width: 210px;
    }
    .guide-cat {
      display: none;
    }
  }
  /* compact: кассета и наклейка в ряд, «Петь» во всю ширину. */
  @media (max-width: 599px) {
    .deck {
      flex-direction: column;
      align-items: stretch;
      padding: 10px;
    }
    .slot {
      gap: var(--s-3);
      padding: 6px 10px;
    }
    .slot :global(.cassette) {
      width: 88px !important;
    }
    .search {
      width: 100%;
    }
  }
  /* short: две колонки — заголовок, фильтры, поиск и кнопка «Петь» слева, лента справа. */
  @media (max-height: 520px) and (orientation: landscape) {
    .pick {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      grid-template-rows: repeat(6, auto) minmax(0, 1fr);
      align-items: start;
      gap: var(--s-2) var(--s-5);
    }
    .pick > .title,
    .resume,
    .sections,
    .search,
    .catalog-status,
    .catalog-error,
    .deck {
      grid-column: 1;
    }
    .pick .carousel {
      grid-column: 2;
      grid-row: 1 / -1;
      align-self: center;
      height: 310px;
    }
    .song {
      width: 168px;
    }
    .deck {
      gap: var(--s-3);
      padding: 8px 10px;
    }
    .slot {
      min-height: 0;
      padding: 6px 8px;
    }
    .slot :global(.cassette) {
      display: none;
    }
    .label-strip {
      padding: 6px 10px;
    }
  }
</style>
