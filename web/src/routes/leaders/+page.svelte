<script lang="ts">
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { api } from "#lib/api/http.ts";
  import type { Leaderboard } from "#lib/api/types.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Star from "#lib/brand/Star.svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Polaroid from "#lib/brand/Polaroid.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  import { CALIBRATION_DEFAULT, RANKS, rankRange } from "#lib/duel/ranks.ts";

  let board = $state<Leaderboard | null>(null);
  let error = $state("");

  $effect(() => {
    if (!account.profile) return;
    api<Leaderboard>("leaderboard")
      .then((b) => (board = b))
      .catch((e: Error) => (error = e.message));
  });

  const rows = $derived(board ? [...board.top, ...(board.me ? [board.me] : [])] : []);
</script>

<svelte:head><title>Топ игроков — Перепев</title></svelte:head>
{#snippet howto()}
  <!-- Пустой лист: как попасть в таблицу и лестница рангов вместо одной фразы на целой тетради. -->
  <section class="howto" aria-labelledby="howto-title">
    <h2 id="howto-title" class="nb-h">Как попасть в таблицу</h2>
    <ol>
      <li>{account.profile ? "Сыграй" : "Войди и сыграй"} {account.rating?.calibrationTotal ?? CALIBRATION_DEFAULT} рейтинговых дуэлей — это калибровка.</li>
      <li>После калибровки появятся ранг и место: таблица идёт по MMR.</li>
      <li>Победа над более сильным соперником даёт больше MMR.</li>
    </ol>
  </section>
{/snippet}
{#snippet ladder()}
  <section class="nb-ranks" aria-labelledby="nb-ranks-title">
    <h2 id="nb-ranks-title" class="nb-h">Ранги</h2>
    <ol role="list">
      {#each RANKS as r, i (r.name)}
        <li><span>{r.name}</span><span class="mono">{rankRange(i)}</span></li>
      {/each}
    </ol>
  </section>
{/snippet}


<!-- Расстановка повторяет мокап «Топ игроков». -->
<section class="scene fit leaders" aria-labelledby="leaders-title">
  <div class="at" style:--x="2%" style:--y="var(--title-top)"><TitleStrip text="Топ игроков" id="leaders-title" fastener="binder" /></div>
  <div class="at book sheet" style:--x="6%" style:--y="18%" style:--w="55%" style:--r="-0.6deg">
    <span class="rings" aria-hidden="true"></span>
    {#if account.loaded && !account.profile}
      <div class="empty-state">
        <div class="empty-main">
          <p class="empty">Таблица лидеров видна только в кабинете.</p>
          <a class="btn btn-primary" href={signInHref("/leaders")}>Войти или зарегистрироваться</a>
          {@render howto()}
        </div>
        {@render ladder()}
        <span class="empty-cat" aria-hidden="true"><Cat mood="sleepy" size="100%" /></span>
      </div>
    {:else if error}
      <p class="notice error" role="alert">{error}</p>
    {:else if board && !rows.length}
      <div class="empty-state">
        <div class="empty-main">
          <p class="empty">Пока никто не прошёл калибровку.</p>
          {#if account.rating?.calibrating}<p class="mine">У тебя калибровка {account.rating.ratedMatches} из {account.rating.calibrationTotal}.</p>{/if}
          <a class="btn btn-primary" href="/duels">В дуэль <span aria-hidden="true">→</span></a>
          {@render howto()}
        </div>
        {@render ladder()}
        <span class="empty-cat" aria-hidden="true"><Cat mood="sleepy" size="100%" /></span>
      </div>
    {:else if board}
      <ol class="table" aria-label="Места по рейтингу">
        {#each rows as r (r.place + r.name)}
          <li class:me={r.me}>
            <span class="place mono">{r.place}</span>
            <span class="mark" aria-hidden="true"><Star variant={r.place <= 3 ? "patch" : "outline"} size={22} /></span>
            <span class="name">{r.me ? `${r.name} (ты)` : r.name}</span>
            <span class="mmr mono">{r.mmr}</span>
          </li>
        {/each}
      </ol>
      {#if account.rating?.calibrating}<p class="mine">У тебя калибровка {account.rating.ratedMatches} из {account.rating.calibrationTotal}: место появится после неё.</p>{/if}
    {:else}
      <p class="empty muted">Загружаем таблицу…</p>
    {/if}
  </div>
  <span class="at deco first-photo" style:--x="66%" style:--y="18%" style:--w="14%" style:--r="5deg"><Polaroid caption="На своей волне"><Cat mood="groove" size="86%" /></Polaroid></span>
  <span class="at second-photo" style:--x="82%" style:--y="33%" style:--w="14%" style:--r="-5deg"><Polaroid caption="Твой выход"><Cat mood="listening" size="86%" /></Polaroid></span>
  <span class="at deco" style:--x="77%" style:--y="16%" style:--w="1.5%" style:--r="-12deg"><Asset name="hardware/paperclip-s02" /></span>
  <span class="at deco" style:--x="91%" style:--y="31%" style:--w="2.5%"><Asset name="hardware/binder-clip-s03" /></span>
  <a class="at stage-pass sheet" href="/duels" style:--x="67%" style:--y="70%" style:--w="28%" style:--r="-3deg"><span class="pass-clip" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={22} /></span><span class="mono">ПРОПУСК НА СЦЕНУ</span><strong>Следующий голос — твой</strong><span class="pass-link">В дуэль →</span></a>

</section>

<style>
  .stage-pass { display: grid; gap: 10px; padding: 20px 24px; border-left: 6px solid var(--accent); text-decoration: none; color: var(--ink); transition: translate 180ms; }
  .stage-pass:hover { translate: 0 -3px; }
  .stage-pass .mono { font-size: 11px; }
  .stage-pass strong { font: 700 clamp(22px,2.5cqi,36px)/1.1 var(--font-hand); }
  .pass-link { font-size: 14px; font-weight: 700; color: var(--accent); }
  .pass-clip { position: absolute; right: 15px; top: -22px; }

  .second-photo { transition: translate 240ms ease, rotate 240ms ease; }
  .second-photo:hover { translate: 0 -3px; rotate: 1deg; }
  @media (prefers-reduced-motion: reduce) { .second-photo:hover { translate: none; rotate: none; } }
  .book {
    height: 76%;
    padding: var(--s-5) var(--s-6) var(--s-4) var(--s-7);
    overflow: auto;
  }
  .rings {
    position: absolute;
    top: 16px;
    bottom: 16px;
    left: -10px;
    width: 26px;
    background:
      radial-gradient(circle 4px at 20px 50%, var(--room) 96%, transparent) 0 0 / 26px 30px repeat-y,
      linear-gradient(90deg, transparent 2px, #8e8d88 2px, #e2e1db 8px, #9e9d98 13px, transparent 13px) 0 9px / 26px 30px repeat-y;
    pointer-events: none;
  }
  .table {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .table li {
    display: grid;
    grid-template-columns: 2.5rem 2rem 1fr auto;
    align-items: center;
    gap: var(--s-3);
    min-height: 2.6rem;
    padding: 0 var(--s-2);
    border-bottom: 1px solid var(--rule);
    font-size: clamp(1rem, 1.25cqi, 1.5rem);
  }
  /* Своя строка — под жёлтым маркером, как на мокапе. */
  .table li.me {
    background: linear-gradient(100deg, transparent, rgb(242 215 78 / 0.85) 2%, rgb(242 215 78 / 0.7) 98%, transparent);
    font-weight: 700;
  }
  .mark {
    display: grid;
    place-items: center;
  }
  .mark :global(.outline svg polygon) {
    stroke: var(--ink);
  }
  .mmr {
    font-weight: 500;
  }
  .empty {
    font-family: var(--font-hand);
    font-size: 1.5rem;
    font-weight: 600;
  }
  /* Пустая таблица: слева подпись, действие и как попасть в таблицу, справа лестница рангов,
     спящий кот внизу справа (в wide он прячется, если лист низкий). */
  .empty-state {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
    grid-template-rows: auto 1fr;
    grid-template-areas: "main ranks" "cat cat";
    gap: var(--s-4) var(--s-7);
    min-height: 100%;
  }
  .empty-main {
    grid-area: main;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-4);
  }
  /* Размеры от ширины листа (cqi): на большом мониторе текст не теряется на огромной странице. */
  .empty-state .empty {
    font-size: clamp(1.5rem, 3.6cqi, 2.1rem);
  }
  .nb-h {
    font: 700 clamp(1.45rem, 3cqi, 1.9rem)/1.1 var(--font-hand);
    letter-spacing: 0;
  }
  .howto {
    display: grid;
    gap: var(--s-2);
    margin-top: var(--s-3);
    padding-top: var(--s-3);
    border-top: 1px dashed var(--line-strong);
  }
  .howto ol {
    display: grid;
    gap: var(--s-1);
    margin: 0;
    padding-left: 1.3em;
    color: var(--ink-2);
    font-size: clamp(var(--t-s), 2cqi, 1.05rem);
  }
  .nb-ranks {
    grid-area: ranks;
    display: grid;
    align-content: start;
    gap: var(--s-2);
  }
  .nb-ranks ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .nb-ranks li {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
    min-height: 1.9rem;
    align-items: center;
    padding: 0 var(--s-2);
    border-bottom: 1px solid var(--rule);
    font-size: clamp(var(--t-s), 2cqi, 1.05rem);
    font-weight: 600;
  }
  .nb-ranks .mono {
    color: var(--ink-2);
    font-size: var(--t-xs);
  }
  .empty-cat {
    grid-area: cat;
    align-self: end;
    justify-self: center;
    width: min(260px, 40%);
    opacity: 0.95;
  }
  /* wide: пустой лист — контейнер (заполненная таблица считает cqi от сцены, как раньше).
     Низкий лист (1280×600, масштаб 150 %): кот уступает место тексту, шрифт мельче. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .book:has(.empty-state) { container-type: size; }
  }
  @container (max-height: 560px) {
    .empty-state { grid-template-areas: "main ranks" "main cat"; }
    .empty-cat { width: min(220px, 90%); }
  }
  @container (max-height: 380px) {
    .empty-cat { display: none; }
  }
  @container (max-height: 400px) {
    .empty-state .empty { font-size: 1.2rem; }
    .empty-main { gap: var(--s-2); }
    .howto { margin-top: 0; }
    .howto ol { font-size: var(--t-xs); gap: 0; }
    .nb-ranks li { min-height: 1.6rem; }
  }
  .mine {
    margin-top: var(--s-3);
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  /* Не wide: таблица во всю ширину, пропуск на сцену под ней. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .leaders { padding-top: var(--title-top); }
    .leaders .second-photo { width: min(230px,80%); align-self: center; margin: 14px 0; }
    .book {
      width: 100%;
      height: auto;
    }
    .empty-state { grid-template-columns: minmax(0, 1fr); grid-template-areas: "main" "ranks" "cat"; }
    /* На телефоне длинная кнопка входа шире листа: переносится внутри листа, а не обрезается краем. */
    .empty-state .btn {
      max-width: 100%;
      white-space: normal;
      text-align: center;
      line-height: 1.1;
      padding-block: var(--s-2);
    }
  }
</style>
