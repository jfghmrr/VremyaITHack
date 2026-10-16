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
  import Locker from "#lib/ui/Locker.svelte";
  import IncomingChallenge from "#lib/ui/IncomingChallenge.svelte";
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
<section class="scene home" aria-labelledby="hero-title">
  <button class="at star-switch object" class:lit={star} style:--x="3%" style:--y="6%" style:--w="7%" aria-label="Зажечь звезду" aria-pressed={star} onclick={() => star = !star}><Star size="100%" /></button>
  <h1 class="at logo" id="hero-title" style:--x="25%" style:--y="5%" style:--w="58%"><span class="visually-hidden">Перепев</span><Asset name="branding/logo-main-s01" /></h1>
  <p class="at tagline" style:--x="35%" style:--y="30%" style:--w="40%"><span>Караоке, где твой голос</span><span>имеет значение <svg viewBox="0 0 40 42" aria-hidden="true"><path d="M20 37C11 25 2 16 6 8c4-7 12-4 14 4 2-8 11-11 15-4 5 9-7 22-15 29Z" /></svg></span></p>
  <button class="at home-cat object" style:--x="1%" style:--y="42%" style:--w="29%" aria-label="Погладить кота" aria-pressed={petted} onclick={() => petted = !petted}>
    <span class="chair" aria-hidden="true"><Asset name="furniture/armchair" /></span>
    <Cat mood={playing ? "groove" : "idle"} size="65%" say={petted ? "мур-р ♡" : ""} />
  </button>
  <div class="at music-corner" style:--x="34%" style:--y="50%" style:--w="33%">
    <div class="boombox" class:playing><Asset name="devices/boombox-s02" />
      <button class="preview-surface" title={previewTrack ? `${playing ? "Остановить" : "Послушать"}: ${previewTrack.song.title}` : "Загружаем песни"} type="button" aria-label={playing ? "Выключить магнитофон" : "Включить магнитофон"} aria-describedby="home-preview-track" aria-pressed={playing} disabled={!previewReady || soundLoading} onclick={preview}></button>
      <span class="radio-light" class:on={playing} aria-hidden="true"></span>
    </div>
    <div class="music-actions">
      <button class="listen-link" aria-label={playing ? "Остановить песню" : "Послушать песню"} aria-pressed={playing} disabled={!previewReady || soundLoading} onclick={preview}><span aria-hidden="true">{playing ? "■" : "▶"}</span> {soundLoading ? "Включаем…" : playing ? "Остановить" : "Послушать песню"}</button>
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
      {:else if statsLoaded}<strong class="locker-number">{songCount}</strong><span>разных песен</span><span>{performances.length} исполнений</span>{#if best !== null}<span>Рекорд <b>{Math.round(best)}/100</b></span>{/if}
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
  .music-corner { height: 46%; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .boombox { position: relative; flex: 1; min-height: 0; width: 100%; max-width: 360px; }
  .boombox :global(img) { height: 100%; width: 100%; object-fit: contain; }
  .music-actions { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; flex-shrink: 0; flex-direction: column; }
  .preview-surface { position: absolute; inset: 0; border: 0; background: transparent; border-radius: 8px; }
  .preview-surface:focus-visible { outline: 2px solid var(--paper); outline-offset: 5px; }
  .radio-light { position: absolute; pointer-events: none; width: 5px; height: 5px; right: 20%; top: 32%; border-radius: 50%; background: #51201b; }
  .radio-light.on { background: #ef493b; box-shadow: 0 0 9px #ed492e; }
  .listen-link { display: flex; align-items: center; gap: 8px; min-height: 32px; border: 0; padding: 4px 12px; color: var(--paper); background: #171715b3; border-radius: 3px; font-size: 13px; }
  .listen-link:hover { background: #39342b; }
  .preview-track { margin: -5px 0 0; width: 100%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--on-room-2); font-size: 11px; }
  .lockers { height: 53%; display: grid; grid-template-columns: 1fr 1fr; gap: 5px; z-index: 4; }
  .start { min-height: 46px; padding: 6px 22px 8px; font-size: clamp(24px,2.2cqi,34px); rotate: -1deg; white-space: nowrap; }
  .promise { margin: 0; color: var(--on-room-2); font-size: 12px; text-align: center; }
  .sound-error { position: absolute; right: 0; top: 0; }
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
</style>
