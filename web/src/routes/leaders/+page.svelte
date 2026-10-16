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

<!-- Расстановка повторяет мокап «Топ игроков». -->
<section class="scene leaders" aria-labelledby="leaders-title">
  <div class="at" style:--x="3%" style:--y="3%"><TitleStrip text="Топ игроков" id="leaders-title" fastener="binder" /></div>
  <div class="at book sheet" style:--x="6%" style:--y="18%" style:--w="55%" style:--r="-0.6deg">
    <span class="rings" aria-hidden="true"></span>
    {#if account.loaded && !account.profile}
      <p class="empty">Таблица лидеров видна только в кабинете. <a href={signInHref("/leaders")}>Войти или зарегистрироваться</a></p>
    {:else if error}
      <p class="notice error" role="alert">{error}</p>
    {:else if board && !rows.length}
      <p class="empty">Пока никто не прошёл калибровку. В таблицу попадают игроки после {account.rating?.calibrationTotal ?? 10} рейтинговых дуэлей.</p>
      {#if account.rating?.calibrating}<p class="mine">У тебя калибровка {account.rating.ratedMatches} из {account.rating.calibrationTotal}.</p>{/if}
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
  <span class="at deco" style:--x="66%" style:--y="18%" style:--w="14%" style:--r="5deg"><Polaroid caption="На своей волне"><Cat mood="groove" size="86%" /></Polaroid></span>
  <span class="at second-photo" style:--x="82%" style:--y="33%" style:--w="14%" style:--r="-5deg"><Polaroid caption="Твой выход"><Cat mood="listening" size="86%" /></Polaroid></span>
  <span class="at deco" style:--x="77%" style:--y="16%" style:--w="1.5%" style:--r="-12deg"><Asset name="hardware/paperclip-s02" /></span>
  <span class="at deco" style:--x="91%" style:--y="31%" style:--w="2.5%"><Asset name="hardware/binder-clip-s03" /></span>
  <a class="at stage-pass sheet" href="/duels" style:--x="67%" style:--y="68%" style:--w="28%" style:--r="-3deg"><span class="pass-clip" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={22} /></span><span class="mono">ПРОПУСК НА СЦЕНУ</span><strong>Следующий голос — твой</strong><span class="pass-link">В дуэль →</span></a>

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
  .empty a {
    color: var(--accent);
  }
  .mine {
    margin-top: var(--s-3);
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  /* Не wide: таблица во всю ширину, пропуск на сцену под ней. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .leaders .second-photo { width: min(230px,80%); align-self: center; margin: 14px 0; }
    .book {
      width: 100%;
      height: auto;
    }
  }
</style>
