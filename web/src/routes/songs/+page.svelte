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
  import { count, FRAGMENTS, sec } from "#lib/ui/format.ts";
  import { PHONE_QUERY } from "#lib/ui/stage.svelte.ts";

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
    // Телефон: подсказка в поле как в макете. Страница пререндерится с «Поиск…», поэтому текст
    // меняется после загрузки (размер поля от него не зависит).
    const phone = matchMedia(PHONE_QUERY);
    const hint = () => { if (search) search.placeholder = phone.matches ? "Название или исполнитель" : "Поиск…"; };
    hint();
    phone.addEventListener("change", hint);
    return () => { audio?.pause(); removeEventListener("hashchange", focusSearch); phone.removeEventListener("change", hint); };
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

</script>

<svelte:head><title>Выбор песни — Перепев</title></svelte:head>

<IncomingChallenge />

<!-- Расстановка по мокапу «Выбор песни». На широком экране строки идут колонкой (заголовок
     с фильтрами, строка каталога, лента, кассетная дека), лента занимает остаток высоты:
     на любом мониторе и масштабе карточки не налезают на строку каталога и деку. -->
<section class="scene pick" aria-labelledby="pick-title">
  <div class="head">
    <div class="title">
      <TitleStrip text="Выбор песни" id="pick-title" pin />
      <span class="scribble deco" aria-hidden="true"></span>
    </div>
    <div class="toolbar">
      <div class="sections segmented" role="group" aria-label="Раздел каталога">
        {#each catalogSections as name (name)}
          <button type="button" aria-pressed={section === name} onclick={() => (section = name)}>{name}</button>
        {/each}
      </div>
      <label class="search">
        <span class="visually-hidden">Поиск песни</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>
        <input id="search" type="search" bind:this={search} bind:value={query} placeholder="Поиск…" autocomplete="off" />
      </label>
    </div>
    <div class="catalog-bar">
      <p class="catalog-status" aria-live="polite">{loading ? "Загружаем каталог…" : count(visible.length, FRAGMENTS)}{#if !loading}<span class="dot" aria-hidden="true">{" · "}</span><span class="hint">Выбери, послушай и подпевай</span>{/if}</p>
      {#if last.result}
        <a class="resume" href="/result">
          <span class="stub mono" aria-hidden="true">{Math.round(last.result.score)}</span>
          <span>Последний разбор: <b>{last.song?.title}</b>, {last.result.score.toFixed(1)}</span>
          <span class="resume-go">Вернуться</span>
        </a>
      {/if}
      {#if account.profile}
        <a class="btn tracks-link" href="#my-tracks"><span class="tracks-icon" aria-hidden="true"></span>Мои треки ↓</a>
      {:else if account.loaded}
        <a class="btn tracks-link" href={signInHref("/songs#my-tracks")}><span class="tracks-icon" aria-hidden="true"></span>Свой трек — после входа</a>
      {/if}
    </div>
  </div>

  {#if error}<p class="notice error catalog-error" role="alert">{error}<button type="button" onclick={() => error = ""} aria-label="Закрыть ошибку">×</button></p>{/if}

  <div class="carousel">
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
              <span class="mono dur">{sec(song.duration_s)} <AgeBadge age={song.age ?? "0+"} /></span>
              {#if song.preview}
                <button type="button" class="listen" aria-label="{playing === song.id ? 'Остановить' : 'Послушать'} «{song.title}»" aria-pressed={playing === song.id} onclick={(e) => { e.preventDefault(); void listen(song); }}>
                  <span class="listen-glyph" aria-hidden="true">{playing === song.id ? "■" : "▶"}</span>
                  <span class="listen-text">{playing === song.id ? "Стоп" : "Послушать"}</span>
                  <!-- Телефон: круглая кнопка с нарисованным значком вместо подписи. -->
                  <svg class="listen-icon" viewBox="0 0 24 24" aria-hidden="true">{#if playing === song.id}<path d="M8.2 7.6h7.7v8.8H8.1z" />{:else}<path d="M9.3 6.8l8.1 5.3-8.2 5.2z" />{/if}</svg>
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

  <div class="deck">
    <div class="slot">
      <!-- Телефон: обложка выбранной песни в панели «Петь» (кассета скрыта). -->
      {#if chosen}<span class="deck-cover" aria-hidden="true"><Cover id={chosen.id} title={chosen.title} contour={chosen.contour} /></span>{/if}
      {#if chosen}
        <Cassette label="Перепев" note={sec(chosen.duration_s)} tone={playing === chosen.id ? "red" : "black"} spinning={playing === chosen.id} width={110} />
      {/if}
      <div class="label-strip"><strong>{chosen?.title ?? "Выбери песню"}</strong>{#if chosen}<span>{chosen.artist.split(" · ")[0]}{" · "}{sec(chosen.duration_s)}{#if chosen.license}{"\u00a0· "}<a href={`/legal/music#${chosen.id}`}>{`${chosen.license}\u00a0↗`}</a>{/if}</span>{/if}</div>
    </div>
    <!-- При входящем вызове основное действие — принять его; выбор песни остаётся второстепенным. -->
    <button class="btn choose" class:btn-primary={!incoming.challenge} disabled={!chosen} aria-label={chosen ? `Петь «${chosen.title}»` : "Петь"} onclick={() => chosen && goto(`/sing/${chosen.id}`)}>
      <!-- Подпись целиком одной строкой текста (разрыв на «Петь » и «→» сдвигал стрелку на доли
           пикселя на компьютере); на телефоне вместо неё «Петь» без стрелки, как в макете. -->
      <span class="choose-label">Петь →</span><span class="choose-phone">Петь</span>
    </button>
    <span class="guide-cat" aria-hidden="true"><Cat mood="listening" size="100%" /></span>
  </div>

  <span class="at deco" style:--x="2%" style:--y="64%" style:--w="3.4%" style:--r="-10deg"><Pin kind="note" size="100%" /></span>
  <span class="at deco" style:--x="60%" style:--y="2%" style:--w="2.4%" style:--r="14deg"><Pin kind="note" size="100%" /></span>
</section>

{#if account.profile}<MyTracks />{/if}

<style>
  /* Шапка: ярлык слева; справа фильтры и поиск, под ними строка каталога. */
  .head {
    display: grid;
    gap: var(--s-3);
    width: 100%;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3) var(--s-4);
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
  /* Строка каталога: крупнее и на тёмной подложке, чтобы не сливалась с фоном (правка P8). */
  .catalog-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
  }
  .catalog-status {
    margin: 0;
    padding: 5px 12px 6px;
    border-radius: 3px;
    background: rgb(18 17 18 / 0.82);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.45);
    color: var(--on-room);
    font-size: clamp(0.95rem, 1.2cqi, 1.2rem);
    font-weight: 500;
    line-height: 1.35;
  }
  .catalog-status .dot {
    color: var(--on-room-3);
  }
  .catalog-status .hint {
    color: var(--on-room-2);
  }
  /* «Мои треки ↓» — заметная бумажная кнопка с кассетой. */
  .tracks-link {
    margin-left: auto;
    font-size: clamp(0.95rem, 1.15cqi, 1.15rem);
    font-weight: 700;
  }
  .tracks-icon {
    width: 1.5em;
    height: 1em;
    border: 2px solid currentColor;
    border-radius: 3px;
    background:
      radial-gradient(circle at 30% 50%, currentColor 0 2.5px, transparent 3px),
      radial-gradient(circle at 70% 50%, currentColor 0 2.5px, transparent 3px);
  }
  .catalog-error { z-index: 5; display: flex; gap: 16px; align-items: center; max-width: 84%; }
  .catalog-error button { background: transparent; border: 0; color: inherit; cursor: pointer; font-size: 24px; }
  .vocal-label { font-size: 10px; color: var(--accent); font-weight: 650; margin-top: 4px; }
  /* Лицензия переносится целиком («CC BY 4.0 ↗»), точка-разделитель остаётся в конце строки. */
  .label-strip a { color: var(--accent); text-underline-offset: 2px; white-space: nowrap; }
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
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-2);
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
    --card-width: 210px;
    --card-gap: clamp(28px, 4cqi, 56px);
    display: flex;
    align-items: center;
    gap: var(--card-gap);
    height: 100%;
    min-width: 0;
    margin: 0;
    padding: 18px 24px;
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
  .caption > .title {
    display: block;
    overflow-wrap: anywhere;
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
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    column-gap: 4px;
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
  .label-strip span { display: block; margin-top: 4px; font-size: 13px; line-height: 1.3; }
  .choose {
    min-width: 132px;
  }
  /* Кот сидит справа от деки, а не висит над лентой и не закрывает карточки. */
  .guide-cat {
    position: absolute;
    left: calc(100% + 14px);
    bottom: 2px;
    width: clamp(56px, 6cqi, 96px);
    pointer-events: none;
  }

  /* wide: колонка — шапка, лента на остаток высоты, дека. В коротком окне (масштаб 150 %
     с панелями браузера) лента не ниже 330 px, страница прокручивается, карточки не режутся. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .pick {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: clamp(8px, 1.8svh, 18px);
      height: auto;
      min-height: calc(100svh - var(--chrome));
      padding: var(--title-top) 0 clamp(6px, 1.4svh, 14px);
    }
    .head {
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--s-2) clamp(16px, 3cqi, 48px);
      padding-left: 2%;
    }
    .head .title {
      grid-row: 1 / span 2;
    }
    .search {
      margin-left: auto;
    }
    .catalog-bar {
      grid-column: 2;
    }
    .carousel {
      flex: 1 1 0;
      min-height: 330px;
      max-height: 500px;
      width: min(94%, calc(26cqi * 3 + 2 * clamp(28px, 4cqi, 56px) + 144px));
      margin-inline: auto;
      /* Размер карточки считается от высоты и ширины ленты (cqh/cqi ленты). */
      container-type: size;
    }
    .songs {
      --card-width: max(150px, min(calc(100cqh - 170px), calc((100cqi - 96px - 2 * var(--card-gap)) / 3), 300px));
    }
    .deck {
      width: 76%;
      margin-inline: auto;
    }
    .catalog-error {
      align-self: center;
    }
  }
  /* xwide (2560×1440, 3440×1440): карточки крупнее, лента выше. */
  @media (min-width: 1100px) and (min-height: 521px) and (min-width: 2200px), (min-width: 1100px) and (min-height: 521px) and (min-aspect-ratio: 21/9) {
    .carousel {
      max-height: 580px;
    }
    .songs {
      --card-width: max(150px, min(calc(100cqh - 190px), calc((100cqi - 96px - 2 * var(--card-gap)) / 3), 360px));
    }
  }
  /* Сенсорный экран или не wide: цели нажатия не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .resume,
    .tracks-link {
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
      height: 360px;
    }
    .songs {
      padding-inline: 24px;
    }
    .guide-cat {
      display: none;
    }
    .tracks-link {
      margin-left: 0;
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
    .catalog-status {
      font-size: var(--t-m);
    }
  }
  /* Не wide: ярлык заголовка на той же высоте под шапкой, что на остальных страницах. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .pick {
      padding-top: var(--title-top);
    }
  }
  /* short: две колонки — заголовок, фильтры, поиск и кнопка «Петь» слева, лента справа. */
  @media (max-height: 520px) and (orientation: landscape) {
    .pick {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      grid-template-rows: repeat(3, auto) minmax(0, 1fr);
      align-items: start;
      gap: var(--s-2) var(--s-5);
    }
    .pick > .head,
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
    .catalog-status {
      font-size: var(--t-s);
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

  /* Иконка круглой кнопки, обложка и подпись «Петь» в панели — только на телефоне. */
  .listen-icon,
  .deck-cover,
  .choose-phone {
    display: none;
  }
  /* Телефон (PHONE_QUERY, макет владельца, экран 02): поиск, разделы, число фрагментов, список
     песен строками (обложка, название, исполнитель, длительность, круглая кнопка прослушивания;
     выбранная — красная рамка и галочка) и панель «Петь» над нижним меню. */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .pick {
      gap: var(--s-3);
      padding-bottom: var(--s-3);
    }
    .head {
      gap: var(--s-3);
    }
    .toolbar {
      display: grid;
      gap: var(--s-3);
    }
    .search {
      order: -1;
      width: 100%;
      min-height: 50px;
      padding: 0 var(--s-4);
      border: 0;
      border-radius: 4px;
      background: var(--paper-2) var(--tex-paper);
      box-shadow: var(--shadow-sheet);
    }
    .search svg {
      width: 22px;
      height: 22px;
      stroke-width: 2;
    }
    .search input {
      font-size: 1rem;
    }
    .sections {
      display: grid;
      grid-auto-columns: minmax(0, 1fr);
      grid-auto-flow: column;
      width: 100%;
    }
    .sections > button {
      min-height: 46px;
      padding: 0 var(--s-2);
      font-size: var(--t-m);
    }
    .catalog-bar {
      gap: var(--s-2) var(--s-3);
    }
    .catalog-status {
      padding: 0;
      background: none;
      box-shadow: none;
      color: var(--on-room);
      font-size: var(--t-m);
    }
    .catalog-status .dot,
    .catalog-status .hint {
      display: none;
    }
    .tracks-link {
      margin-left: auto;
      font-size: var(--t-s);
    }
    /* Список вместо ленты полароидов. */
    .carousel {
      display: block;
      height: auto;
    }
    .arrow {
      display: none;
    }
    .songs {
      display: grid;
      gap: 0;
      height: auto;
      padding: 0;
      overflow: visible;
      mask-image: none;
      scroll-snap-type: none;
      background: var(--paper-2) var(--tex-paper);
      box-shadow: var(--shadow-sheet);
      border-radius: 3px;
    }
    .song,
    .song:hover {
      grid-template-columns: 64px minmax(0, 1fr) auto;
      grid-template-areas: "cover title listen" "cover artist listen" "cover meta listen";
      align-items: center;
      column-gap: var(--s-3);
      width: auto;
      max-width: none;
      padding: 10px var(--s-3);
      background: transparent;
      box-shadow: inset 0 -1px 0 var(--line);
      transform: none;
    }
    .song.checked {
      z-index: 1;
      background: #f7e6e1;
      box-shadow: inset 0 0 0 2px var(--accent);
      transform: none;
    }
    /* Галочка выбранной песни: красный кружок с белой отметкой слева от кнопки прослушивания. */
    .song.checked::after {
      top: 50%;
      left: auto;
      right: 66px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6.4 12.4l3.7 3.6 7.6-8' fill='none' stroke='%23f5f0e6' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 18px no-repeat;
      transform: translateY(-50%);
    }
    .cover {
      grid-area: cover;
      width: 64px;
      --cover-fs: 12cqi;
    }
    .caption,
    .meta {
      display: contents;
    }
    .caption > .title {
      grid-area: title;
      padding-right: 30px;
      font-size: var(--t-l);
    }
    /* Название и исполнитель не заходят под галочку выбранной песни (24 px у правого края). */
    .artist {
      grid-area: artist;
      -webkit-line-clamp: 1;
      line-clamp: 1;
      padding-right: 30px;
      font-size: var(--t-s);
    }
    .vocal-label {
      display: none;
    }
    .dur {
      grid-area: meta;
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font-family: var(--font);
      font-size: var(--t-s);
      color: var(--ink-2);
    }
    .listen {
      grid-area: listen;
      display: grid;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      min-height: var(--tap);
      margin: 0;
      padding: 0;
      border: 2px solid var(--ink);
      border-radius: 50%;
      background: transparent;
    }
    .listen[aria-pressed="true"] {
      border-color: var(--accent);
    }
    .listen-glyph,
    .listen-text {
      display: none;
    }
    .listen-icon {
      display: block;
      width: 20px;
      height: 20px;
      fill: currentColor;
      stroke: currentColor;
      stroke-width: 1.2;
      stroke-linejoin: round;
    }
    .none {
      padding: var(--s-4);
      color: var(--ink-2);
    }
    /* Панель «Петь»: прилипает над нижним меню, пока виден список. */
    .deck {
      position: sticky;
      bottom: calc(var(--bar-space, 0px) + var(--s-2));
      z-index: 5;
      flex-direction: row;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-2);
      border: 0;
      border-radius: 4px;
      background: var(--paper) var(--tex-paper);
      box-shadow: 0 -2px 0 rgb(0 0 0 / 0.25), var(--shadow-pop);
    }
    .slot {
      gap: var(--s-3);
      min-height: 0;
      padding: 0;
      background: none;
      box-shadow: none;
    }
    .slot :global(.cassette) {
      display: none;
    }
    .deck-cover {
      display: block;
      flex: none;
      width: 52px;
      container-type: inline-size;
      --cover-fs: 12cqi;
    }
    .label-strip {
      padding: 0;
      border: 0;
      background: none;
    }
    .label-strip strong {
      font: 700 var(--t-m) / 1.2 var(--font);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label-strip span {
      margin-top: 2px;
      color: var(--ink-2);
      font-size: var(--t-xs);
    }
    .choose {
      flex: none;
      min-width: 104px;
      min-height: 50px;
      font-family: var(--font);
      font-size: 1.2rem;
    }
    .choose-label {
      display: none;
    }
    .choose-phone {
      display: inline;
    }
  }
</style>
