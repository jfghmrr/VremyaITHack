<script lang="ts">
  import { achievementsOf } from "#lib/achievements.ts";
  import { account } from "#lib/api/account.svelte.ts";
  import { api } from "#lib/api/http.ts";
  import { guestAttempts, type Attempt } from "#lib/history.svelte.ts";
  import Axes from "#lib/ui/Axes.svelte";
  import { plural, signed } from "#lib/ui/format.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Star from "#lib/brand/Star.svelte";
  import Cassette from "#lib/brand/Cassette.svelte";
  import Decor from "#lib/brand/Decor.svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  type MatchItem = { id: string; kind: string; state: string; songId: string; outcome: string | null; score: number | null; at: string | null };
  let showHistory = $state(false);
  let attempts = $state<Attempt[]>([]), matches = $state<MatchItem[]>([]);
  let historyError = $state(""), loading = $state(true);
  $effect(() => {
    const id = account.profile?.id;
    if (!account.loaded) return;
    let active = true;
    attempts = []; matches = []; historyError = ""; loading = true;
    if (!id) { attempts = guestAttempts(); loading = false; return; }
    Promise.all([api<{ attempts: Attempt[] }>("attempts"), api<{ matches: MatchItem[] }>("matches")])
      .then(([a,m]) => { if (active) { attempts = a.attempts; matches = m.matches; } })
      .catch(e => { if (active) historyError = (e as Error).message; })
      .finally(() => { if (active) loading = false; });
    return () => { active = false; };
  });
  // Прогресс по песне показываем только при трёх и более попытках: меньше — это не тренд.
  const bySong = $derived.by(() => {
    const groups = new Map<string, Attempt[]>();
    for (const a of attempts) groups.set(a.songId, [...(groups.get(a.songId) ?? []), a]);
    return [...groups.entries()].map(([id, list]) => ({
      id,
      title: list[0].title,
      count: list.length,
      best: Math.max(...list.map((a) => a.score)),
      series: list.map((a) => a.score).reverse(),
    }));
  });

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const outcomeText: Record<string, string> = { win: "Победа", draw: "Ничья", loss: "Поражение" };
  // Общий график: баллы последних попыток по порядку, как проведённый ручкой на миллиметровке.
  const chart = $derived(attempts.slice(0, 24).reverse());
  const W = 600;
  const H = 200;
  const px = (i: number) => 40 + (i / Math.max(1, chart.length - 1)) * (W - 60);
  const py = (v: number) => 14 + (1 - v / 100) * (H - 44);
  const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "numeric" }) : "");
  const achievements = $derived(achievementsOf(attempts, matches));
  const songCount = $derived(new Set(attempts.map(a => a.songId)).size);
  const spark = (xs: number[]) =>
    xs.map((v, i) => `${i ? "L" : "M"}${((i / Math.max(1, xs.length - 1)) * 100).toFixed(1)} ${(40 - (v / 100) * 36).toFixed(1)}`).join("");
</script>
<svelte:head><title>Мой прогресс — Перепев</title></svelte:head>
  <div class="cabinet">
    <div class="cabinet-switch" role="group" aria-label="Раздел кабинета"><button class="key" aria-pressed={!showHistory} onclick={() => showHistory = false}>Мой прогресс</button><button class="key" aria-pressed={showHistory} onclick={() => showHistory = true}>История исполнений</button><a class="settings-link" href="/account">Настройки аккаунта ↗</a></div>
    {#if loading}<p class="load-state" role="status">Загружаем историю…</p>{/if}
    {#if historyError && !showHistory}<p class="notice error" role="alert">{historyError}</p>{/if}
    <!-- Расстановка повторяет мокап «Мой прогресс»: разворот тетради с графиком и достижениями. -->
    <section class="scene progress" aria-label="Мой прогресс" hidden={showHistory}>
      <div class="at" style:--x="5%" style:--y="3%"><TitleStrip text="Мой прогресс" tag="div" fastener="paperclip" /></div>
      <div class="at progress-name" style:--x="67%" style:--y="4%"><h1>{account.profile?.name ?? "Твой прогресс"}</h1><span class="small">{account.rating?.calibrating ? `${songCount} ${plural(songCount, ["песня", "песни", "песен"])} · ${attempts.length} ${plural(attempts.length, ["попытка", "попытки", "попыток"])}` : account.rating?.rank ?? "Твоя музыкальная тетрадь"}</span></div>
      <span class="at progress-cat" style:--x="82%" style:--y="77%" style:--w="11%" aria-hidden="true"><Cat mood="happy" size="100%" /></span>
      <div class="at spread" style:--x="4%" style:--y="17%" style:--w="92%">
        <span class="notebook-clip" aria-hidden="true"><Asset name="hardware/binder-clip-s03" /></span>
        <div class="page left">
          <div class="chart">
            {#if chart.length >= 2}
              <svg viewBox="0 0 {W} {H}" role="img" aria-label="Баллы последних попыток: {chart.map((a) => a.score.toFixed(0)).join(', ')}">
                {#each [0, 25, 50, 75, 100] as v (v)}
                  <line x1="40" x2={W - 20} y1={py(v)} y2={py(v)} class="grid" />
                  <text x="32" y={py(v) + 4} text-anchor="end" class="axis">{v}</text>
                {/each}
                <polyline points={chart.map((a, i) => `${px(i)},${py(a.score)}`).join(" ")} class="pen" />
                {#each chart as a, i (a.id)}
                  <circle cx={px(i)} cy={py(a.score)} r="4.5" class="dot" />
                  {#if i === 0 || i === chart.length - 1 || i % Math.ceil(chart.length / 5) === 0}
                    <text x={px(i)} y={H - 8} text-anchor="middle" class="axis">{shortDate(a.at)}</text>
                  {/if}
                {/each}
              </svg>
            {:else}
              <p class="chart-empty">Здесь появится график, когда попыток станет две и больше.</p>
            {/if}
          </div>
        </div>
        <span class="spine" aria-hidden="true"></span>
        <div class="page right">
          <h2 class="ach-title">Достижения</h2>
          <ul class="ach">
            {#each achievements as a (a.id)}
              <li class:got={a.got} aria-label="{a.label}: {a.got ? 'получено' : 'ещё не получено'}">
                <span class="sticker" aria-hidden="true">
                  {#if a.icon === "star"}<Star variant="patch" size="100%" />
                  {:else if a.icon === "tape"}<Cassette label="mix" tone="black" width={90} />
                  {:else if a.icon === "cat"}<Cat mood="happy" size="100%" />
                  {:else if a.icon === "mic"}<Decor kind="micstand" width="40%" />
                  {:else if a.icon === "vs"}<Star variant="spiral" size="100%" />
                  {:else}<Star variant="print" size="100%" />{/if}
                  {#if !a.got}<span class="lock"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg></span>{/if}
                </span>
                <span class="ach-label">{a.label}</span>
              </li>
            {/each}
          </ul>
        </div>
      </div>
      <p class="at steps-note note deco" style:--x="37%" style:--y="86%" style:--r="-2deg">Маленькие шаги — большие результаты! ♡</p>

    </section>
    <div class="details" hidden={!showHistory}>
    <section class="history book" aria-labelledby="history-title">
      <span class="rings" aria-hidden="true"></span>
      <h2 id="history-title">История исполнений</h2>
      {#if historyError}<p class="notice error" role="alert">{historyError}</p>{/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex — прокручиваемая область должна получать фокус с клавиатуры -->
      <div class="list" tabindex="0" role="region" aria-label="Список попыток и матчей">
        {#if !attempts.length && !matches.length}
          <div class="empty">
            <Cat mood="lying" size={150} />
            <div>
              <p>Здесь будут твои попытки и дуэли.</p>
              <a class="btn btn-primary" href="/songs">Спеть первую песню</a>
            </div>
          </div>
        {/if}
        {#if matches.length}
          <h3>Дуэли</h3>
          <ul>
            {#each matches as m (m.id)}
              <li>
                <span>{m.kind === "rated" ? "Рейтинговая" : "С другом"}, {m.songId}</span>
                <span>{m.state === "finished" ? outcomeText[m.outcome ?? ""] ?? "" : m.state === "cancelled" ? "Отменена" : "Сбой, без результата"}{m.score != null ? `, ${m.score.toFixed(1)}` : ""}</span>
                <span class="small muted mono">{date(m.at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if attempts.length}
          <h3>Попытки <span class="small muted">без аудио: запись голоса не хранится</span></h3>
          <ul>
            {#each attempts as a (a.id)}
              <li>
                <span>{a.title}</span>
                <span><b>{a.score.toFixed(1)}</b> <span class="small muted">сдвиг {signed(a.shift)}</span></span>
                <span class="small muted mono">{date(a.at)}</span>
                <details class="axes-detail"><summary class="small">Оси</summary><Axes axes={a.axes} compact /></details>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
    <aside class="profile panel">
      <div class="singing-summary" aria-label="Прогресс пения"><strong>Спето песен: {songCount}</strong><span>Сохранено попыток: {attempts.length}</span></div>
      {#if account.rating}
        <div class="rating">
          {#if account.rating.calibrating}
            <p class="rank">Рейтинговые дуэли: {account.rating.ratedMatches} из {account.rating.calibrationTotal}</p>
            <p class="small muted">Это отдельный прогресс для подбора соперников. Одиночные песни учтены выше. Ранг появится после {account.rating.calibrationTotal} рейтинговых дуэлей.</p>
          {:else}
            <p class="rank">{account.rating.rank} <span class="mmr mono">MMR {account.rating.mmr}</span></p>
            <p class="small muted">MMR меняется только после рейтинговых дуэлей: победа над сильным соперником даёт больше. Баллы за песни на него не влияют.</p>
          {/if}
          {#if account.rating.protected}
            <p class="small muted">Пока у тебя меньше 20 матчей, подбор не сводит тебя с игроками уровня 1400 и выше.</p>
          {/if}
        </div>
      {/if}
      {#if bySong.length}
        <div class="songs">
          <h3>По песням</h3>
          {#each bySong as s (s.id)}
            <div class="song">
              <b>{s.title}</b>
              <span class="small muted">{s.count} {plural(s.count, ["попытка", "попытки", "попыток"])}, лучшая {s.best.toFixed(1)}</span>
              {#if s.count >= 3}
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Баллы по попыткам: {s.series.join(', ')}">
                  <path d={spark(s.series)} fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
                </svg>
              {:else}
                <span class="small muted">График появится после трёх попыток.</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </aside>
    </div>
  </div>
<style>
  .singing-summary { display: grid; gap: 4px; margin: 16px 0; padding: 14px; border-left: 4px solid var(--accent); background: #eadbbd80; }
  .singing-summary strong { font-size: 20px; }
  .singing-summary span { font-size: 13px; }
  .spread {
    display: grid;
    grid-template-columns: 1fr 18px 1fr;
    height: 66%;
    filter: drop-shadow(0 16px 22px rgb(0 0 0 / 0.7));
    rotate: -0.5deg;
  }
  .notebook-clip { position: absolute; z-index: 3; left: 4%; top: -22px; width: clamp(24px, 2.4cqi, 38px); pointer-events: none; transform: rotate(-4deg); }
  .page {
    position: relative;
    min-height: 0;
    padding: var(--s-5);
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
    --muted: var(--ink-2);
  }
  .page.left {
    background-image:
      linear-gradient(rgb(110 150 170 / 0.22) 1px, transparent 1px),
      linear-gradient(90deg, rgb(110 150 170 / 0.22) 1px, transparent 1px),
      linear-gradient(90deg, transparent calc(100% - 26px), rgb(0 0 0 / 0.14)),
      var(--tex-paper);
    background-size: 18px 18px, 18px 18px, auto, auto;
  }
  .page.right {
    background-color: #ddd2bb;
    background-image: linear-gradient(90deg, rgb(0 0 0 / 0.14), transparent 26px), var(--tex-paper);
  }
  .spine {
    background:
      radial-gradient(circle 4px at 9px 50%, var(--room) 96%, transparent) 0 0 / 18px 26px repeat-y,
      linear-gradient(90deg, #8e8d88, #e2e1db 50%, #8e8d88) 0 8px / 18px 26px repeat-y;
  }
  .chart {
    height: 100%;
    display: grid;
    align-items: center;
  }
  .chart svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .grid {
    stroke: rgb(31 28 26 / 0.25);
    stroke-width: 1;
  }
  .axis {
    font-family: var(--font-mono);
    font-size: 11px;
    fill: var(--ink-2);
  }
  .pen {
    fill: none;
    stroke: var(--accent);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .dot {
    fill: var(--accent);
    stroke: var(--paper-2);
    stroke-width: 2;
  }
  .chart-empty {
    font-family: var(--font-hand);
    font-size: clamp(1.2rem, 1.6cqi, 2rem);
    font-weight: 600;
    text-align: center;
    color: var(--ink-2);
  }
  .ach-title {
    display: inline-block;
    margin: 0 0 var(--s-4);
    padding: 4px 18px 6px;
    background: var(--paper) var(--tex-paper);
    font-family: var(--font-hand);
    font-size: clamp(1.4rem, 1.8cqi, 2.2rem);
    letter-spacing: 0;
    rotate: -2deg;
    box-shadow: var(--shadow-sticker);
  }
  .ach {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--s-4) var(--s-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ach li {
    display: grid;
    justify-items: center;
    gap: var(--s-1);
    text-align: center;
  }
  .sticker {
    position: relative;
    display: grid;
    place-items: center;
    width: clamp(56px, 6cqi, 110px);
    aspect-ratio: 1;
  }
  .ach li:not(.got) .sticker > :global(*:not(.lock)) {
    filter: grayscale(1) brightness(0.8);
    opacity: 0.35;
  }
  .lock {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .lock svg {
    width: 44%;
    fill: #6f675d;
    stroke: #6f675d;
    stroke-width: 2;
  }
  .lock svg path {
    fill: none;
  }
  .ach-label {
    font-size: var(--t-xs);
    color: var(--ink-2);
  }
  .got .ach-label {
    color: var(--ink);
    font-weight: 600;
  }
  .steps-note {
    margin: 0;
    padding: 8px 18px 10px;
    background-color: var(--paper);
    font-family: var(--font-hand);
    font-size: clamp(1.1rem, 1.5cqi, 1.9rem);
    font-weight: 700;
  }
  .cabinet { padding-bottom: 0; height: calc(100svh - var(--chrome)); display: grid; grid-template-rows: auto minmax(0,1fr); gap: 8px; }
  .cabinet-switch { display: flex; gap: 6px; justify-content: flex-end; }
  .progress { height: 100%; }
  .progress-name h1 { font: 700 1.7rem/1.1 var(--font-hand); }
  .progress-name .small { color: var(--on-room-2); }
  .progress-cat { z-index: 2; }
  .details {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr);
    gap: var(--s-6);
    align-items: stretch;
  }
  .book,
  .panel {
    position: relative;
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-sheet);
    --muted: var(--ink-2);
  }
  .history {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: grid;
    gap: var(--s-3);
    padding: var(--s-4) var(--s-5) var(--s-4) var(--s-7);
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
  .profile {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: grid;
    align-content: start;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-5);
  }
  .rating {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border: 2px solid var(--ink);
    border-radius: 2px;
  }
  .rank {
    font-family: var(--font-poster);
    font-size: var(--t-xl);
    font-weight: 600;
  }
  .mmr {
    margin-left: var(--s-2);
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  .songs {
    display: grid;
    gap: var(--s-2);
  }
  .songs h3 {
    font-size: var(--t-m);
  }
  .song {
    display: grid;
    gap: 2px;
    padding-bottom: var(--s-2);
    border-bottom: 1px solid var(--rule);
  }
  .song svg {
    width: 100%;
    height: 34px;
  }
  .list {
    max-height: 60vh;
    overflow: auto;
    padding: 0 var(--s-2) var(--s-2) 0;
  }
  .list h3 {
    margin: var(--s-3) 0 var(--s-2);
    font-size: var(--t-m);
  }
  .list ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: grid;
    grid-template-columns: 1.4fr 1fr auto auto;
    gap: var(--s-4);
    align-items: center;
    min-height: 42px;
    border-bottom: 1px solid var(--rule);
  }
  .list li b {
    font-family: var(--font-mono);
    font-weight: 500;
  }
  .axes-detail summary {
    cursor: pointer;
    color: var(--ink-2);
  }
  .axes-detail[open] {
    grid-column: 1 / -1;
    padding-bottom: var(--s-3);
  }
  .empty {
    display: flex;
    align-items: center;
    gap: var(--s-5);
    padding: var(--s-4) 0;
  }
  .empty div {
    display: grid;
    gap: var(--s-3);
    justify-items: start;
  }
  .empty p {
    font-family: var(--font-hand);
    font-size: 1.6rem;
    font-weight: 700;
  }

  .settings-link { color: var(--on-room-2); font-size: 13px; padding: 8px; }
  .load-state { position: absolute; top: 80px; z-index: 2; }
  .history h2 { font: 700 1.6rem/1.1 var(--font-hand); margin: 4px 0; }
  .list { max-height: none; }
  .cabinet-switch { flex-wrap: wrap; align-items: center; }
  /* Сенсорный экран или не wide: ссылка на настройки не ниже 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .settings-link { display: inline-flex; align-items: center; min-height: var(--tap); }
  }
  /* Не wide: разворот тетради в одну колонку, страница прокручивается. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .cabinet { height: auto; } .progress { height: auto; }
    .progress-name { order: -1; } .progress-cat { display: none; }
    .details, .spread { grid-template-columns: 1fr; } .spread { width: 100%; height: auto; }
    .spine { display: none; } .profile, .history { overflow: visible; }
    .list li { grid-template-columns: 1fr auto; gap: 8px; }
  }
</style>
