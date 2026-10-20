<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { api } from "#lib/api/http.ts";
  import type { Friends } from "#lib/api/types.ts";
  import { guestAttempts, type Attempt } from "#lib/history.svelte.ts";
  import { asset, loadCatalog, type CatalogEntry } from "#lib/catalog.ts";
  import { homePreview, type SungPerformance } from "#lib/home-preview.ts";
  import Star from "#lib/brand/Star.svelte";
  import { count, plural } from "#lib/ui/format.ts";
  import Locker from "#lib/ui/Locker.svelte";
  import IncomingChallenge from "#lib/ui/IncomingChallenge.svelte";
  import Cassette from "#lib/brand/Cassette.svelte";
  let star = $state(false), petted = $state(false), playing = $state(false);
  let friends = $state<Friends | null>(null), statsError = $state(false), friendsError = $state(false);
  let performances = $state<SungPerformance[]>([]);
  let statsLoaded = $state(false);
  let catalog = $state<CatalogEntry[]>([]), catalogLoading = $state(true), catalogError = $state("");
  const previewTrack = $derived(homePreview(catalog, performances));
  const previewReady = $derived(statsLoaded && !catalogLoading && previewTrack !== null);
  const songCount = $derived(new Set(performances.map(a => a.songId)).size);
  const best = $derived(performances.length ? Math.max(...performances.map(a => a.score)) : null);
  onMount(() => { void refreshCatalog(); });
  async function refreshCatalog() {
    catalogLoading = true; catalogError = "";
    try { catalog = await loadCatalog(); }
    catch { catalogError = "Не удалось загрузить песни для магнитофона."; }
    finally { catalogLoading = false; }
  }
  $effect(() => {
    const id = account.profile?.id;
    if (!account.loaded) return;
    friends = null; friendsError = false; statsError = false;
    if (!id) { performances = guestAttempts(); statsLoaded = true; return; }
    let active = true; statsLoaded = false; performances = [];
    const refresh = () => {
      if (document.hidden) return;
      api<Friends>("friends").then(f => { if (active) { friends = f; friendsError = false; } }).catch(() => { if (active) friendsError = true; });
    };
    refresh();
    Promise.all([api<{attempts: Attempt[]}>("attempts"), api<{matches: {state: string; songId: string; score: number | null; at: string | null}[]}>("matches")]).then(([a,m]) => {
      if (active) { performances = [...a.attempts, ...m.matches.filter(x => x.state === "finished" && x.score !== null).map(x => ({songId:x.songId, score:x.score!, at:x.at}))]; statsLoaded = true; }
    }).catch(() => { if (active) { statsError = true; statsLoaded = true; } });
    const timer = setInterval(refresh, 15000);
    return () => { active = false; clearInterval(timer); };
  });
  let audio: HTMLAudioElement | null = null;
  let soundError = $state(""), soundLoading = $state(false);
  function stopPreview() {
    const previous = audio;
    audio = null;
    if (previous) { previous.onended = null; previous.onerror = null; previous.pause(); }
    playing = false; soundLoading = false;
  }
  onDestroy(stopPreview);
  $effect(() => { previewTrack?.song.id; account.profile?.id; stopPreview(); });
  async function preview() {
    soundError = "";
    if (playing) { stopPreview(); return; }
    if (!previewReady || !previewTrack?.song.preview) return;
    stopPreview(); soundLoading = true;
    const next = new Audio(asset(previewTrack.song.id, previewTrack.song.preview));
    audio = next;
    const failed = () => {
      if (audio !== next) return;
      stopPreview(); soundError = "Не удалось включить песню. Попробуй ещё раз.";
    };
    next.onended = () => { if (audio === next) stopPreview(); };
    next.onerror = failed;
    try { await next.play(); if (audio === next) { playing = true; soundLoading = false; } }
    catch { failed(); }
  }
</script>
<svelte:head><title>Перепев — караоке, где твой голос имеет значение</title></svelte:head>
<IncomingChallenge />
<!-- Телефон (макет владельца 18.10.2026, экран 01): записка «Пой в своей тональности» с котом,
     «Начать петь» во всю ширину и две карточки разделов. Комната со шкафчиками — на остальных
     раскладках; на телефоне скрыта. -->
<section class="phone-home" aria-labelledby="phone-hero-title">
  <h1 class="visually-hidden" id="phone-hero-title">Перепев</h1>
  <div class="hero">
    <p class="hero-note"><span>Пой в своей</span> <span>тональности</span>
      <svg class="hero-stroke" viewBox="0 0 120 14" aria-hidden="true"><path d="M3 9.5c18-4.6 41-6.4 62-5.6 17 .6 33 2.5 52 5.1" /></svg>
    </p>
    <svg class="hero-doodle" viewBox="0 0 64 64" aria-hidden="true"><path d="M38 12.5v24.8" /><path d="M38.2 12.4c4.4 1.9 8.4 4.4 9.7 9.5" /><ellipse cx="33.6" cy="38.6" rx="5.2" ry="4.1" transform="rotate(-18 33.6 38.6)" /><path d="M19.5 24.2l1.7 9.4M24.8 21.5l1 6.8" /></svg>
    <span class="hero-cat" aria-hidden="true"><Cat mood="idle" size="100%" loading="eager" /></span>
    <svg class="hero-lines" viewBox="0 0 40 40" aria-hidden="true"><path d="M32 9.5 15.8 14M33.5 19.4l-18.9 1.4M31.6 29.4 16.8 26.2" /></svg>
  </div>
  <p class="hero-lead">Выбери фрагмент,<br />проверь микрофон — и&nbsp;пой.</p>
  <a class="hero-go" href="/songs">Начать петь <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.2h14.6M13.2 6.3l5.9 5.9-5.9 6" /></svg></a>
  <p class="hero-solo">Соло — без регистрации</p>
  <ul class="home-cards" role="list">
    <li>
      <a class="home-card" href="/duels">
        <svg class="card-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path class="handle" d="M20.6 21.7 38.4 40.6" /><path class="handle" d="M27.4 21.7 9.6 40.6" />
          <circle class="head red" cx="15.2" cy="14.6" r="7.4" /><circle class="head ink" cx="32.8" cy="14.6" r="7.4" />
          <path class="grille" d="M10.8 11.6l7.7 7.4M12.7 9.2l6.9 6.6M28.4 19l7.6-7.4M30.3 21l6.9-6.7" />
        </svg>
        <span class="card-text"><b>Дуэли</b><span>Пой и соревнуйся</span></span>
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 5.8l6.1 6.3-6.2 6.1" /></svg>
      </a>
    </li>
    <li>
      <a class="home-card" href="/progress">
        <svg class="card-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path class="bar" d="M9.6 38.8v-8.9M18.4 38.8V24.1M27.2 38.8V17.6" /><path class="bar red" d="M36 38.8V10.4" />
        </svg>
        <span class="card-text"><b>Мой прогресс</b><span>История исполнений</span></span>
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 5.8l6.1 6.3-6.2 6.1" /></svg>
      </a>
    </li>
  </ul>
  <div class="home-deco" aria-hidden="true">
    <span class="deco-star"><Star size={58} /></span>
    <svg class="deco-dashes" viewBox="0 0 40 30" aria-hidden="true"><path d="M5 11.5l26-6.2M8.4 22.2l24.5-2.8" /></svg>
    <span class="deco-tape"><Cassette label="Перепев" tone="black" width={132} /></span>
  </div>
</section>
<section class="scene fit home" aria-labelledby="hero-title">
  <button class="at star-switch object" class:lit={star} style:--x="3%" style:--y="6%" style:--w="7%" aria-label="Зажечь звезду" aria-pressed={star} onclick={() => star = !star}><Star size="100%" loading="eager" skipOnPhone /></button>
  <h1 class="at logo" id="hero-title" style:--x="25%" style:--y="5%" style:--w="58%"><span class="visually-hidden">Перепев</span><Asset name="branding/logo-main-s01" loading="eager" /></h1>
  <p class="at tagline" style:--x="35%" style:--y="30%" style:--w="40%"><span>Караоке, где твой голос</span><span>имеет значение <svg viewBox="0 0 40 42" aria-hidden="true"><path d="M20 37C11 25 2 16 6 8c4-7 12-4 14 4 2-8 11-11 15-4 5 9-7 22-15 29Z" /></svg></span></p>
  <button class="at home-cat object" style:--x="1%" style:--y="42%" style:--w="29%" aria-label="Погладить кота" aria-pressed={petted} onclick={() => petted = !petted}>
    <span class="chair" aria-hidden="true"><Asset name="furniture/armchair" loading="eager" skipOnPhone /></span>
    <Cat mood={playing ? "groove" : "idle"} size="65%" say={petted ? "мур-р ♡" : ""} loading="eager" />
  </button>
  <div class="at music-corner" style:--x="34%" style:--y="51.5%" style:--w="33%">
    <div class="boombox" class:playing><Asset name="devices/boombox-s02" loading="eager" skipOnPhone />
      <button class="preview-surface" title={previewTrack ? `${playing ? "Остановить" : "Послушать"}: ${previewTrack.song.title}` : "Загружаем песни"} type="button" aria-label={playing ? "Выключить магнитофон" : "Включить магнитофон"} aria-describedby="home-preview-track" aria-pressed={playing} disabled={!previewReady || soundLoading} onclick={preview}></button>
      <span class="radio-light" class:on={playing} aria-hidden="true"></span>
    </div>
    <div class="music-actions">
      <button class="key listen-link" aria-label={playing ? "Остановить песню" : "Послушать песню"} aria-pressed={playing} disabled={!previewReady || soundLoading} onclick={preview}><span aria-hidden="true">{playing ? "■" : "▶"}</span> {soundLoading ? "Включаем…" : playing ? "Остановить" : "Послушать песню"}</button>
      <p class="preview-track" id="home-preview-track" title={previewTrack?.song.title}>{!statsLoaded || catalogLoading ? "Загружаем песни…" : previewTrack ? `${previewTrack.fromHistory ? "Последняя спетая" : "Из каталога"}: ${previewTrack.song.title}` : "Нет доступных записей"}</p>
      <a class="btn btn-primary start" href="/songs">Начать петь <span aria-hidden="true">→</span></a>
    </div>
    <p class="promise">Пой в своей тональности. Главное — мелодия и ритм.</p>
  </div>
  <aside class="at lockers" style:--x="77%" style:--y="41%" style:--w="20%" aria-label="Музыкальные шкафчики">
    <Locker label="Друзья" href="/friends" tone="red">
      <span class="locker-heading">Свои люди</span>
      {#if !account.profile}<span>Собери свою компанию</span>
      {:else if friendsError}<span>Не удалось загрузить список</span>
      {:else if friends}
        <strong class="locker-number">{friends.friends.length}</strong><span>в твоём списке</span>
        {#if friends.incoming.length}<b class="incoming">Заявок: {friends.incoming.length}</b>{/if}
        <ul class="locker-names">{#each friends.friends.slice(0, 2) as f}<li>{f.name}</li>{/each}</ul>
      {:else}<span>Загружаем…</span>{/if}
      <a href="/friends">Открыть список →</a>
    </Locker>
    <Locker label="Мои песни" href="/progress" tone="green">
      <span class="locker-heading">Уже спето</span>
      {#if statsError}<span>История временно недоступна</span>
      {:else if statsLoaded}<strong class="locker-number">{songCount}</strong><span>{plural(songCount, ["разная песня", "разные песни", "разных песен"])}</span><span>{count(performances.length, ["исполнение", "исполнения", "исполнений"])}</span>{#if best !== null}<span>Рекорд <b>{Math.round(best)}/100</b></span>{/if}
      {:else}<span>Загружаем…</span>{/if}
      <a href="/progress">Мой прогресс →</a>
    </Locker>
  </aside>
  {#if soundError || catalogError}<div class="sound-error notice error" role="alert"><span>{soundError || catalogError}</span>{#if catalogError}<button class="key" onclick={refreshCatalog}>Повторить</button>{:else}<button class="key" aria-label="Закрыть сообщение" onclick={() => soundError = ""}>×</button>{/if}</div>{/if}
  <span class="at deco" style:--x="80%" style:--y="4%" style:--w="1.6%" style:--r="14deg"><Asset name="hardware/paperclip-s02" /></span>
</section>
<style>
  .object { padding: 0; border: 0; background: none; transition: filter 180ms ease, transform 180ms ease; }
  .object:hover { transform: translateY(-3px) rotate(-1deg); }
  .object:active { transform: translateY(2px) scale(.98); }
  .logo, .tagline { margin: 0; }
  .tagline { padding: 17px 20px 21px; background: var(--paper) var(--tex-paper); color: var(--ink); font: 700 clamp(24px,3.3cqi,48px)/1 var(--font-hand); text-align: center; rotate: -3deg; clip-path: polygon(0 7%,4% 4%,24% 5%,50% 0,70% 3%,96% 0,100% 5%,98% 32%,100% 68%,98% 97%,81% 95%,60% 100%,31% 96%,3% 100%,0 91%,2% 68%,0 45%); }
  .tagline > span { display: block; }
  .tagline svg { display: inline-block; width: .7em; height: .8em; vertical-align: -.12em; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; }
  .logo { filter: drop-shadow(0 7px 5px #0007); }
  /* Место под логотип до загрузки картинки (1600×419): страница не прыгает. */
  .logo :global(img) { aspect-ratio: auto 1600 / 419; }
  .star-switch.lit { filter: drop-shadow(0 0 16px #d94a2980) brightness(1.3); }
  .home-cat { height: 53%; display: flex; justify-content: center; padding: 0; }
  .chair { position: absolute; inset: 0; }
  .chair :global(img) { width: 100%; height: 100%; object-fit: contain; }
  .home-cat :global(.cat) { position: absolute; top: -4%; left: 18%; }
  .home-cat :global(.cat) { z-index: 1; }
  .locker-heading { font: 700 clamp(19px,1.6cqi,25px)/1 var(--font-hand); }
  .locker-number { font: 600 clamp(32px,3.6cqi,52px)/1 var(--font-poster); color: var(--accent); }
  .locker-names { list-style: none; padding: 0; margin: 0; max-width: 100%; }
  .locker-names li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .incoming { color: var(--accent); }
  .music-corner { height: 44.5%; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .boombox { position: relative; flex: 1; min-height: 0; width: 100%; max-width: 360px; }
  .boombox :global(img) { height: 100%; width: 100%; object-fit: contain; aspect-ratio: auto 520 / 368; }
  .music-actions { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; flex-shrink: 0; flex-direction: column; }
  .preview-surface { position: absolute; inset: 0; border: 0; background: transparent; border-radius: 8px; }
  .preview-surface:focus-visible { outline: 2px solid var(--paper); outline-offset: 5px; }
  .radio-light { position: absolute; pointer-events: none; width: 5px; height: 5px; right: 20%; top: 32%; border-radius: 50%; background: #51201b; }
  .radio-light.on { background: #ef493b; box-shadow: 0 0 9px #ed492e; }
  /* Клавиша кассетной деки (.key) под магнитофоном: как кнопки плеера на сцене пения. */
  .listen-link { min-height: 36px; padding: 0 14px; font-size: clamp(13px, 1.05cqi, 16px); }
  .preview-track { margin: -5px 0 0; width: 100%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--on-room-2); font-size: clamp(12px, 0.95cqi, 15px); }
  .lockers { height: 53%; display: grid; grid-template-columns: 1fr 1fr; gap: 5px; z-index: 4; }
  /* wide: шкафчик примерно 1 : 2.7, как на мокапе — на высоком мониторе не вытягивается в столб. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .lockers { height: auto; aspect-ratio: 20 / 27; max-height: 53%; }
  }
  .start { min-height: 46px; padding: 6px 22px 8px; font-size: clamp(24px,2.2cqi,34px); rotate: -1deg; white-space: nowrap; }
  .promise { margin: 0; color: var(--on-room-2); font-size: clamp(12px, 1cqi, 16px); text-align: center; }
  .sound-error { position: absolute; right: 0; top: 0; }
  /* Короткое широкое окно (масштаб 150 % с панелями браузера): слоган компактнее и не ложится на магнитофон. */
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 680px) {
    .tagline { padding: 12px 18px 15px; font-size: clamp(20px, 2.8cqi, 40px); }
  }
  /* Сенсорный экран или не wide: цели нажатия не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .listen-link { min-height: var(--tap); }
    .sound-error .key { min-width: var(--tap); }
  }
  /* Не wide: комната идёт потоком. Главное действие выше кота и шкафчиков. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .home { align-items: center; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; padding-top: 14px; }
    .home .logo, .home .tagline, .home .music-corner { grid-column: 1/-1; justify-self: center; }
    .home .logo { width: min(580px,90%); }
    .home .tagline { width: min(360px,75%); }
    .home .star-switch { display: none; }
    .home .music-corner { width: 100%; height: auto; }
    .home .boombox { flex: none; width: min(270px,75%); }
    .home .home-cat { grid-column: 1/-1; order: 1; width: min(260px,100%); height: 290px; justify-self: center; }
    .home .lockers { grid-column: 1/-1; order: 2; width: min(260px,76%); height: 330px; justify-self: center; }
    .music-actions { flex-wrap: wrap; }
    .promise { text-align: center; }
    .sound-error { position: relative; grid-column: 1/-1; order: 3; }
  }
  /* compact: кнопка «Начать петь» в первом экране телефона. */
  @media (max-width: 599px) {
    .home { gap: 16px; }
    .home .boombox { width: min(230px, 64%); }
    .home .home-cat { width: min(210px, 70%); height: 230px; }
  }
  /* short: ландшафт телефона — название слева, магнитофон и «Начать петь» справа. */
  @media (max-height: 520px) and (orientation: landscape) {
    .home {
      grid-template-areas: "logo music" "tagline music" "cat lockers";
      gap: 12px var(--s-6);
      padding-top: 4px;
    }
    .home .logo { grid-area: logo; width: min(400px, 100%); }
    .home .tagline { grid-area: tagline; width: min(320px, 90%); }
    .home .music-corner { grid-area: music; gap: 8px; }
    .home .boombox { width: min(220px, 70%); }
    .home .home-cat { grid-area: cat; width: min(210px, 100%); height: 230px; }
    .home .lockers { grid-area: lockers; width: min(220px, 80%); height: 250px; }
    .promise { display: none; }
  }

  /* Телефон (PHONE_QUERY, макет владельца): блок .phone-home вместо комнаты. */
  .phone-home { display: none; }
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .scene.home { display: none; }
    .phone-home {
      display: grid;
      gap: var(--s-3);
      max-width: 34rem;
      margin-inline: auto;
      padding-top: var(--s-2);
    }
    .hero { position: relative; min-height: 168px; }
    /* Записка из рваной бумаги, рукописный текст и красная черта от руки. */
    .hero-note {
      position: relative;
      width: 84%;
      padding: 18px 20px 30px 22px;
      background: var(--paper) var(--tex-paper);
      color: var(--ink);
      font: 700 clamp(2.2rem, 10.6vw, 2.8rem)/0.98 var(--font-hand);
      rotate: -2.5deg;
      clip-path: polygon(0 9%, 6% 3%, 21% 6%, 44% 0, 63% 4%, 88% 1%, 100% 7%, 97% 36%, 100% 64%, 96% 95%, 76% 92%, 54% 100%, 30% 95%, 6% 100%, 1% 86%, 3% 55%);
      filter: drop-shadow(0 6px 8px rgb(0 0 0 / 0.5));
    }
    .hero-note > span { display: block; }
    .hero-note > span + span { padding-left: 6px; }
    .hero-stroke { position: absolute; left: 30px; bottom: 12px; width: 92px; height: 12px; fill: none; stroke: var(--accent); stroke-width: 4.5; stroke-linecap: round; }
    .hero-doodle { position: absolute; right: 2%; top: -6px; width: 54px; height: 54px; fill: none; stroke: var(--on-room); stroke-width: 2.4; stroke-linecap: round; rotate: 8deg; }
    .hero-doodle ellipse { fill: var(--on-room); }
    /* Кот заходит на правый нижний угол записки (около трети ширины, как в макете). */
    .hero-cat { position: absolute; right: -2px; top: 46px; width: min(31vw, 150px); rotate: 4deg; }
    .hero-lines { position: absolute; right: calc(min(31vw, 150px) + 2px); top: 128px; width: 30px; height: 30px; fill: none; stroke: var(--on-room); stroke-width: 2.4; stroke-linecap: round; }
    .hero-lead { max-width: 66%; margin-top: -4px; color: var(--on-room); font-size: var(--t-m); line-height: 1.45; }
    /* Главное действие — красная полоса во всю ширину, текст Golos (как в макете). */
    .hero-go {
      position: relative;
      z-index: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--s-2);
      min-height: 58px;
      margin-top: var(--s-1);
      color: var(--paper-2);
      font: 700 1.3rem/1 var(--font);
      text-decoration: none;
      filter: drop-shadow(0 3px 0 rgb(0 0 0 / 0.55));
    }
    .hero-go::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      background: var(--accent) var(--tex-paper);
      border-radius: 4px;
      clip-path: polygon(0 5%, 24% 1%, 52% 4%, 79% 0, 100% 3%, 99.4% 52%, 100% 96%, 70% 100%, 41% 96.5%, 12% 100%, 0.4% 97%, 0 50%);
    }
    .hero-go:active { translate: 0 2px; filter: none; }
    .hero-go svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .hero-solo { margin-top: -4px; color: var(--on-room-2); font-size: var(--t-s); text-align: center; }
    /* Карточки разделов: бумага, иконка слева, заголовок и подпись, шеврон справа. */
    .home-cards { display: grid; gap: var(--s-3); margin: var(--s-2) 0 0; padding: 0; list-style: none; }
    .home-card {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr) 24px;
      align-items: center;
      gap: var(--s-4);
      min-height: 78px;
      padding: var(--s-3) var(--s-4);
      background: var(--paper-2) var(--tex-paper);
      color: var(--ink);
      text-decoration: none;
      box-shadow: var(--shadow-sheet);
      border-radius: 2px;
    }
    .home-card:active { translate: 0 1px; }
    .card-icon { width: 52px; height: 52px; fill: none; stroke-linecap: round; }
    .card-icon .handle { stroke: var(--ink); stroke-width: 4.6; }
    .card-icon .head { stroke: var(--ink); stroke-width: 1.8; }
    .card-icon .head.red { fill: var(--accent); }
    .card-icon .head.ink { fill: var(--ink); }
    .card-icon .grille { stroke: var(--paper-2); stroke-width: 1.4; opacity: 0.75; }
    .card-icon .bar { stroke: var(--ink); stroke-width: 6.4; stroke-linecap: square; }
    .card-icon .bar.red { stroke: var(--accent); }
    .card-text { display: grid; gap: 2px; min-width: 0; }
    .card-text b { font-size: var(--t-xl); line-height: 1.15; }
    .card-text span { color: var(--ink-2); font-size: var(--t-m); }
    .chevron { width: 24px; height: 24px; fill: none; stroke: var(--ink); stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
    .home-deco { position: relative; display: flex; align-items: center; justify-content: space-between; min-height: 96px; padding: 0 var(--s-2); pointer-events: none; }
    .deco-star { rotate: -10deg; }
    .deco-dashes { width: 40px; height: 30px; margin-right: auto; fill: none; stroke: var(--on-room); stroke-width: 2.6; stroke-linecap: round; }
    .deco-tape { rotate: 9deg; }
  }
</style>
