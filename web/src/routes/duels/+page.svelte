<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { activeInvite, command, connect, isTerminal, live, reconnectNow, type MatchMode } from "#lib/live/client.svelte.ts";
  import { loadCatalog } from "#lib/catalog.ts";
  import type { SongInfo } from "#lib/api/types.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Star from "#lib/brand/Star.svelte";

  let songs = $state<SongInfo[]>([]);
  let song = $state("");
  // Режим комнаты друга: «Кто лучше» (дуэль, как раньше) или «Вместе» (по очереди, общий балл).
  let mode = $state<MatchMode>("versus");
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

  // Найденный матч и своя комната открываются сами. Уже сыгранный матч — нет: иначе «К дуэлям»
  // с экрана итога сразу уводила обратно на итог. Приглашение на реванш ждёт решения игрока.
  $effect(() => {
    const m = live.match;
    const done = !!m && isTerminal(m);
    const found = live.queue?.status === "matched" ? live.queue.match_id : null;
    const id = found && !(done && m?.match_id === found) ? found : m && !done ? m.match_id : null;
    if (id) void goto(`/duels/match/${id}`);
    else if (live.room && !live.room.invite && (!m || !done)) void goto(`/duels/room/${live.room.code}`);
  });

  const searching = $derived(live.queue?.status === "searching");
  // Приглашение на реванш живёт, пока ждёт комната (15 минут).
  const invite = $derived(activeInvite(now));
  // Первые секунды переподключения кнопки выключены: тихая подсказка вместо немой паузы
  // (после LOST_MS её сменяет плашка с причиной и кнопкой «Переподключить»).
  const reconnecting = $derived(!!account.profile && live.status === "reconnecting" && !live.lost);
  const waited = $derived(searching && live.queue?.since_ms ? Math.max(0, Math.floor((now - live.queue.since_ms) / 1000)) : 0);
  // Почему поиск остановлен сервером (вход в комнату, другой матч) или клиентом (долго без связи).
  const stopped = $derived(!searching && live.queue?.status === "idle" ? (live.queue.note ?? "") : "");

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
    const r = await command({ type: "room_create", song_id: song, mode });
    if (!r.ok) error = r.error ?? "Не удалось создать комнату.";
  }
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
</script>

<svelte:head><title>Дуэли — Перепев</title></svelte:head>

<!-- wide: слева ярлык, вступление и «Как проходит дуэль», справа режимы.
     Не wide: ярлык, режимы, затем подсказка — действия на телефоне не уходят вниз. -->
<div class="duels">
  <header>
    <TitleStrip text="Дуэли" fastener="paperclip" />
    <p class="lead">Двое поют одну мелодию, каждый в своей тональности. Побеждает точность.</p>
    <a class="btn" href="/friends">Друзья и заявки →</a>
  </header>
  <div class="body">

  {#if account.loaded && !account.profile}
    <!-- Текст и ссылка — отдельные части записки: на узком экране ссылка уходит под текст,
         а не сжимает его в узкую колонку рядом с собой (аудит дизайна F7). В wide — тихая
         строка над режимами, а не главный лист страницы. -->
    <p class="notice guest"><span>Для живых дуэлей нужен кабинет: результат и рейтинг сохраняются на сервере.</span> <a href={signInHref("/duels")}>Войти или зарегистрироваться</a></p>
  {/if}
  {#if error || live.error}<p class="notice error" role="alert">{error || live.error}</p>{/if}
  {#if account.profile && live.lost}
    <p class="notice" role="status">
      {live.offline ? "Нет сети. Поиск соперника и комнаты заработают, когда интернет вернётся." : "Связь с сервером дуэлей прервалась, подключаемся заново. Поиск и комнаты заработают через несколько секунд."}
      <button class="btn btn-quiet" onclick={reconnectNow}>Переподключить</button>
    </p>
  {/if}
  {#if reconnecting}<p class="connecting small" role="status">Подключаемся…</p>{/if}
  {#if stopped}<p class="notice" role="status">{stopped}</p>{/if}
  {#if invite}
    <p class="notice invite" role="status">
      {#if invite.mode === "coop"}
        {invite.rival ?? "Друг"} зовёт спеть ещё раз вместе: {invite.song ? `«${invite.song}»` : "та же песня"}, по очереди, без рейтинга.
        <a class="btn btn-primary" href="/duels/room/{invite.code}">Спеть ещё раз</a>
      {:else}
        {invite.rival ?? "Соперник"} зовёт на реванш: {invite.song ? `«${invite.song}»` : "та же песня"}, без рейтинга.
        <a class="btn btn-primary" href="/duels/room/{invite.code}">Принять реванш</a>
      {/if}
      <button class="btn btn-quiet" onclick={() => (live.room = null)}>Не сейчас</button>
    </p>
  {/if}

  <ol class="modes">
    <li class="mode poster" class:active={searching}>
      <span class="badge" aria-hidden="true"><Star variant="print" size={54} /></span>
      <div class="text">
        <h2>Найти соперника</h2>
        <!-- Во время поиска описание режима уступает место пояснениям поиска: всё на одном экране. -->
        {#if !searching}<p>Рейтинговый матч с игроком близкого уровня. Фрагмент сервер выбирает после подбора из общего набора: реже сыгранный вами обоими.</p>{/if}
        {#if searching && live.queue}
          <div class="search" role="status">
            <b class="state"><span class="lamp" aria-hidden="true">ЗАПИСЬ</span> Ищем соперника, <span class="mono">{clock(waited)}</span>{#if live.resumed}<span class="resumed"> · связь прерывалась, поиск начат заново</span>{/if}</b>
            <button class="btn cancel" onclick={cancel}>Отменить поиск</button>
            <div class="details">
              <p class="small">
                {live.queue.pool === "cal" ? "Пул калибровки: сначала те, кто тоже на первых матчах; через 30 с — и остальные игроки, если подходят по окну уровня и защите новичков." : "Основной пул: сначала прошедшие калибровку; через 30 с — и игроки на калибровке, если подходят по окну уровня и защите новичков."}
                Разница уровня сейчас до ±{Math.round(live.queue.window ?? 0)} MMR, окно медленно растёт.
              </p>
              {#if live.queue.note}
                <p class="small why">{live.queue.note}</p>
              {:else if waited >= 30}
                <p class="small">Пока никто не подходит. Можно ждать дальше, позвать друга или спеть с призраком: ботов вместо людей здесь нет.</p>
              {/if}
            </div>
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
        {#if mode === "coop"}
          <p>Комната по ссылке: поёте одну песню по очереди, по строке, а в конце слушаете её целиком. Общий балл, рейтинг не меняется.</p>
        {:else}
          <p>Комната по ссылке: вы оба подтверждаете готовность и поёте одновременно. Рейтинг не меняется.</p>
        {/if}
      </div>
      <div class="room">
        <!-- Режим — в одной строке с песней и кнопкой: карточка не растёт, страница помещается в окно. -->
        <div class="segmented mode-switch" role="group" aria-label="Режим комнаты">
          <button type="button" aria-pressed={mode === "versus"} onclick={() => (mode = "versus")}>Кто лучше</button>
          <button type="button" aria-pressed={mode === "coop"} onclick={() => (mode = "coop")}>Вместе</button>
        </div>
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
  <aside class="guide" aria-labelledby="guide-title">
    <h2 id="guide-title">Как проходит дуэль</h2>
    <ol class="flow" role="list">
      <li><span><b>Подбор.</b> Соперник по рейтингу или друг по ссылке.</span></li>
      <li><span><b>Отсчёт.</b> Оба жмут «Я готов» — общий старт.</span></li>
      <li><span><b>Пение.</b> Одна песня, у каждого своя тональность.</span></li>
      <li><span><b>Итог.</b> Балл считает сервер по линиям высоты.</span></li>
    </ol>
  </aside>
</div>

<style>
  /* Левая колонка больше не пустует под вступлением: в ней «Как проходит дуэль».
     Режимы справа остаются на месте — поиск с длинным пояснением помещается в 1366×768. */
  .duels {
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 8fr);
    grid-template-areas: "head body" "guide body";
    grid-template-rows: auto 1fr;
    gap: var(--s-6) var(--s-8);
    align-items: start;
    padding-top: clamp(var(--s-2), 3vh, var(--s-7));
    padding-bottom: var(--s-4);
  }
  header {
    grid-area: head;
    display: grid;
    gap: var(--s-4);
    justify-items: start;
  }
  .lead {
    font-size: var(--t-l);
    color: var(--on-room-2);
    max-width: 34ch;
  }
  .guide {
    grid-area: guide;
    display: grid;
    gap: var(--s-4);
    min-width: 0;
  }
  .guide h2 {
    color: var(--paper);
    font: 700 2rem/1 var(--font-hand);
    letter-spacing: 0;
  }
  /* Четыре шага по порядку: номера на пунктирной дорожке. */
  .flow {
    display: grid;
    gap: var(--s-3);
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
    background: repeating-linear-gradient(180deg, var(--on-room-3) 0 4px, transparent 4px 9px) calc(0.8rem - 1px) 0.9rem / 2px calc(100% - 1.8rem) no-repeat;
  }
  .flow li {
    counter-increment: step;
    display: grid;
    grid-template-columns: 1.6rem minmax(0, 1fr);
    gap: var(--s-3);
    align-items: center;
    color: var(--on-room-2);
    font-size: var(--t-s);
    line-height: 1.35;
  }
  .flow li::before {
    content: counter(step);
    display: grid;
    place-items: center;
    width: 1.6rem;
    height: 1.6rem;
    border: 2px solid var(--accent-bright);
    border-radius: 50%;
    background: var(--room);
    color: var(--paper);
    font: 700 0.85rem/1 var(--font-poster);
  }
  .flow b {
    color: var(--on-room);
    font-weight: 650;
  }
  .connecting {
    color: var(--on-room-2);
  }
  /* «Принять реванш» в записке: цвет текста кнопки, а не красный цвет ссылок записки (.notice a). */
  .invite .btn {
    color: var(--btn-ink);
  }
  .body {
    grid-area: body;
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
  /* Во время поиска карточка поиска занимает всю ширину афиши: пояснения не вытягивают её вниз. */
  .mode.active .text {
    max-width: none;
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
  /* Строка состояния и «Отменить поиск» сверху, пояснения — на всю ширину карточки под ними. */
  .search {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: "state cancel" "details details";
    gap: var(--s-2) var(--s-4);
    align-items: center;
    margin-top: var(--s-3);
    padding: var(--s-4);
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
  }
  .search .state {
    grid-area: state;
  }
  .search .resumed {
    font-weight: 400;
    color: var(--ink-2);
  }
  .search .cancel {
    grid-area: cancel;
  }
  .search .details {
    grid-area: details;
  }
  .search div {
    display: grid;
    gap: var(--s-1);
  }
  .search .small {
    color: var(--ink-2);
  }
  /* Почему пары пока нет: главное, что нужно знать ждущему, — темнее остального текста. */
  .search .why {
    color: var(--ink);
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
  .mode-switch {
    flex: none;
  }
  /* Гостю: текст записки занимает строку, ссылка переносится под него, когда не помещается. */
  .notice.guest {
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-3);
  }
  .notice.guest span {
    flex: 1 1 18rem;
    min-width: 0;
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
    flex-wrap: wrap;
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
  /* wide: записка гостю — тихая строка на стене над режимами, а не лист во всю ширину. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .notice.guest {
      padding: var(--s-2) 0;
      background: none;
      box-shadow: none;
      color: var(--on-room-2);
      border-bottom: 1px dashed var(--room-line);
    }
    .notice.guest a {
      color: var(--paper);
      text-decoration-color: var(--accent-bright);
      text-decoration-thickness: 2px;
    }
  }
  /* wide на высоком окне («wide-tall» в tokens.css, от 900 px): отступы и поля карточек растут с высотой окна. */
  @media (min-width: 1100px) and (min-height: 900px) {
    .duels { row-gap: clamp(32px, 4svh, 56px); }
    .guide { gap: clamp(16px, 2.2svh, 26px); }
    .flow { gap: clamp(12px, 1.8svh, 22px); }
    .modes, .body { gap: clamp(16px, 2.4svh, 30px); }
    .mode { padding-block: clamp(16px, 2.6svh, 34px); }
  }
  /* wide на низком окне («wide-short», 1366×768): подсказка плотнее — страница с поиском без прокрутки. */
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 820px) {
    .duels { row-gap: var(--s-4); padding-bottom: 0; }
    header { gap: var(--s-3); }
    .guide { gap: var(--s-3); }
    .flow { gap: var(--s-2); }
  }
  /* Не wide: ярлык, режимы, затем подсказка о дуэли (действия не уходят вниз). */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .duels {
      grid-template-columns: 1fr;
      grid-template-areas: "head" "body" "guide";
      grid-template-rows: auto;
      gap: var(--s-5);
    }
    .guide {
      max-width: 34rem;
      margin-top: var(--s-3);
    }
  }
  /* compact: карточки режимов в одну колонку. */
  @media (max-width: 599px) {
    .badge { right: 5px; }
    .search { grid-template-columns: 1fr; grid-template-areas: "state" "details" "cancel"; }
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
