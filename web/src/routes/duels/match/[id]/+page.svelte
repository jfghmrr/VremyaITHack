<script lang="ts">
  import { refreshAchievements } from "#lib/achievements.svelte.ts";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onDestroy, onMount } from "svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { api } from "#lib/api/http.ts";
  import type { MatchView, PlayerResult } from "#lib/api/types.ts";
  import { command, connect, live, resetMatch, serverNow } from "#lib/live/client.svelte.ts";
  import { Capture, loadBacking, micError } from "#lib/audio/capture.ts";
  import { chooseMic, initMics, mics } from "#lib/audio/microphones.svelte.ts";
  import { asset, loadSong, songVersion } from "#lib/catalog.ts";
  import { ALGORITHM_VERSION, canonical, score } from "#lib/scoring/index.svelte.ts";
  import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";
  import { stage } from "#lib/ui/stage.svelte.ts";
  import PianoRoll from "#lib/ui/PianoRoll.svelte";
  import ResultTrace from "#lib/ui/ResultTrace.svelte";
  import Axes from "#lib/ui/Axes.svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import { traceSeries } from "#lib/ui/series.ts";
  import { median } from "#lib/ui/canvas.ts";
  import Cat from "#lib/brand/Cat.svelte";
  import Cutout from "#lib/brand/Cutout.svelte";
  import Star from "#lib/brand/Star.svelte";
  import VuMeter from "#lib/ui/VuMeter.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Polaroid from "#lib/brand/Polaroid.svelte";

  const HOP = 0.05;
  const id = $derived(page.params.id ?? "");

  let song = $state<Song | null>(null);
  let version = $state("");
  let micReady = $state(false);
  let preparing = $state(false);
  let error = $state("");
  let level = $state(0);
  let exitOpen = $state(false);
  let leaving = $state(false);
  let exitTo = "/duels";
  let copied = $state("");
  let showDetails = $state(false);
  let sent = $state(0);
  let preliminary = $state<number | null>(null);
  let finals = $state<{ mine: ScoreResult; theirs: ScoreResult | null; myCurve: PitchFrame[]; theirCurve: PitchFrame[] | null } | null>(null);
  let rivalShift = $state(0);
  let now = $state(Date.now());

  let capture: Capture | null = null;
  let backing: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let scheduled = false;
  let ctxStart = 0;
  let sender = 0;
  let finished = false;
  let sending = false;
  let finalPoints: (number | null)[] | null = null;
  let resentAt = 0;

  const view = $derived<MatchView | null>(live.match?.match_id === id ? live.match : null);
  const me = $derived(view?.players.find((p) => p.user_id === account.profile?.id) ?? null);
  const rival = $derived(view?.players.find((p) => p.user_id !== account.profile?.id) ?? null);
  const n = $derived(song ? Math.ceil(song.duration_s / HOP) : 0);
  const singing = $derived(view?.state === "countdown" || view?.state === "singing");
  const clock = $derived(view?.start_at_ms ? (now - (view.start_at_ms - live.offset)) / 1000 : -1);
  const left = $derived(view?.deadline_ms ? Math.max(0, Math.ceil((view.deadline_ms - (now + live.offset)) / 1000)) : null);
  const rivalCurve = $derived(live.opponent.map((q, i) => ({ t: i * HOP, midi: q == null ? null : q / 10 })));

  onMount(() => {
    const stopMics = initMics();
    if (account.profile) connect();
    const t = setInterval(() => (now = Date.now()), 250);
    // Матч мог закончиться, пока вкладка была закрыта: итог берём из API.
    const fallback = setTimeout(async () => {
      if (!view && account.profile) {
        try {
          live.match = await api<MatchView>(`matches/${id}`);
        } catch (e) {
          error = (e as Error).message;
        }
      }
    }, 2000);
    return () => {
      stopMics();
      clearInterval(t);
      clearTimeout(fallback);
    };
  });

  onDestroy(() => {
    stopAudio();
    stage.dark = false;
    stage.focus = false;
  });

  $effect(() => {
    if (view && !song) loadSong(view.song.id).then((s) => (song = s)).catch((e: Error) => (error = e.message));
  });

  $effect(() => {
    stage.dark = !!singing || view?.state === "collecting";
    stage.focus = !!singing;
  });

  // Общий старт: время сервера переводится в часы AudioContext; звук планируется по ним.
  $effect(() => {
    const v = view;
    if (!v || !song || !capture || !backing || scheduled || !v.start_at_ms || !(v.state === "countdown" || v.state === "singing")) return;
    scheduled = true;
    const mic = capture;
    ctxStart = mic.ctx.currentTime + (v.start_at_ms - serverNow()) / 1000;
    mic.begin(ctxStart, song.duration_s);
    const audio = mic.ctx.createBufferSource();
    audio.buffer = backing;
    audio.connect(mic.ctx.destination);
    const late = Math.max(0, mic.ctx.currentTime - ctxStart);
    audio.start(Math.max(ctxStart, mic.ctx.currentTime), late);
    source = audio;
    sender = window.setInterval(() => void pump(), 100);
  });

  // Итог: обе кривые пересчитываются тем же ядром, что и на сервере, для общего таймлайна.
  $effect(() => {
    const v = view;
    if (v?.state !== "finished" || !song || finals) return;
    void refreshAchievements();
    const s = song;
    const mine = capture ? canonical(capture.frames, s.duration_s) : Promise.resolve(null);
    void mine.then(async (myCurve) => {
      const theirCurve = live.opponent.length === n ? rivalCurve : null;
      const mineResult = myCurve ? await score(myCurve, s) : null;
      const theirs = theirCurve ? await score(theirCurve, s) : null;
      if (mineResult && myCurve) finals = { mine: mineResult, theirs, myCurve, theirCurve };
    });
  });

  // Сдвиг соперника для отображения на сцене: медиана отклонения от эталона.
  $effect(() => {
    if (!song || !singing) return;
    const s = song;
    const diffs = live.opponent.flatMap((q, i) => {
      const r = s.f0_midi[Math.round((i * HOP * 1000) / s.hop_ms)];
      return q != null && r != null ? [q / 10 - r] : [];
    });
    rivalShift = median(diffs.slice(-200));
  });

  async function prepare() {
    if (!song || !view) return;
    preparing = true;
    error = "";
    try {
      capture?.stop();
      capture = await Capture.open((f) => (level = Math.min(100, (f.rms ?? 0) * 600)), mics.selected);
      backing = await loadBacking(capture.ctx, asset(song.id, song.backing));
      version = await songVersion(song.id);
      micReady = true;
      const r = await command({ type: "ready", match_id: view.match_id, song_version: version, algorithm_version: ALGORITHM_VERSION });
      if (!r.ok) error = r.error ?? "Сервер не принял готовность.";
    } catch (e) {
      error = micError(e);
    } finally {
      preparing = false;
    }
  }

  // Отправка кривой: точки, для которых уже есть кадры дальше окна сопоставления (35 мс),
  // окончательны и совпадут с полной канонической кривой. В конце — остаток и finish.
  async function pump() {
    if (sending || finished || !capture || !song || !view) return;
    sending = true;
    try {
      const mic = capture;
      const elapsed = mic.ctx.currentTime - ctxStart;
      const done = elapsed >= song.duration_s + 0.2;
      const frames = mic.frames.slice();
      const curve = await canonical(frames, song.duration_s);
      const lastT = frames.at(-1)?.t ?? -1;
      const upto = done ? n : Math.min(n, Math.floor((lastT - 0.06) / HOP) + 1);
      while (sent < upto) {
        const to = Math.min(upto, sent + 20);
        const points = curve.slice(sent, to).map((f) => (f.midi === null ? null : Math.round(f.midi * 10)));
        void command({ type: "perf", match_id: view.match_id, from: sent, points });
        sent = to;
      }
      if (done && sent >= n) {
        finished = true;
        clearInterval(sender);
        finalPoints = curve.map((f) => (f.midi === null ? null : Math.round(f.midi * 10)));
        void command({ type: "finish", match_id: view.match_id, count: n });
        preliminary = (await score(curve, song)).score;
      }
    } finally {
      sending = false;
    }
  }

  // Страховка: если сервер подтвердил не все точки, отправляем кривую ещё раз.
  // Сервер принимает только первое значение каждой точки, поэтому повтор безопасен.
  $effect(() => {
    const v = view;
    if (!v || !finalPoints || v.state !== "collecting" || !me || me.points >= n || Date.now() - resentAt < 2000) return;
    resentAt = Date.now();
    for (let from = 0; from < n; from += 20) void command({ type: "perf", match_id: v.match_id, from, points: finalPoints.slice(from, from + 20) });
    void command({ type: "finish", match_id: v.match_id, count: n });
  });

  function stopAudio() {
    clearInterval(sender);
    try {
      source?.stop();
    } catch {
      /* уже остановлен */
    }
    capture?.stop();
    capture = null;
  }

  async function leave() {
    if (leaving) return;
    leaving = true;
    exitOpen = false;
    stopAudio();
    if (view) {
      // Команда остаётся в штатной очереди повторов при временном разрыве.
      // Навигация не должна бессрочно ждать сетевого подтверждения.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        command({ type: "leave", match_id: view.match_id }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2500); }),
      ]);
      clearTimeout(timer);
    }
    resetMatch();
    live.queue = null;
    await goto(exitTo);
  }

  beforeNavigate((navigation) => {
    if (leaving || !view || ["finished", "cancelled", "failed"].includes(view.state) || navigation.to?.url.pathname === page.url.pathname) return;
    // При закрытии вкладки нужен родной диалог, а не асинхронный переход через goto.
    if (navigation.willUnload) {
      if (singing || view.state === "collecting") navigation.cancel();
      return;
    }
    navigation.cancel();
    exitTo = navigation.to?.url.href ?? "/duels";
    if (singing || view.state === "collecting") exitOpen = true;
    else void leave();
  });

  function onkeydown(e: KeyboardEvent) {
    // В живом матче индивидуальной паузы нет: общий таймер идёт.
    if (e.key === "Escape" && view && !["finished", "cancelled", "failed"].includes(view.state)) {
      e.preventDefault();
      exitOpen = true;
    }
  }

  async function copyRoom() {
    const url = `${location.origin}/duels/room/${view?.room_code}`;
    try {
      await navigator.clipboard.writeText(url);
      copied = "Ссылка скопирована";
    } catch {
      copied = url;
    }
  }

  async function again() {
    if (!view) return;
    stopAudio();
    const kind = view.kind;
    const matchId = view.match_id;
    resetMatch();
    if (kind === "rated") {
      await command({ type: "queue_join" });
      void goto("/duels");
    } else {
      await command({ type: "rematch", match_id: matchId });
      void goto("/duels");
    }
  }

  const reasons: Record<string, string> = {
    declined: "Один из участников отказался.",
    accept_timeout: "Соперник не подтвердил участие вовремя.",
    ready_timeout: "Не все участники подтвердили готовность вовремя.",
    disconnected: "Участник потерял соединение и не вернулся в отведённое время.",
    left: "Участник вышел из матча.",
    room_expired: "Друг не пришёл в комнату за 15 минут.",
    queue_cancelled: "Поиск был отменён.",
    state_lost: "Временное состояние матча потеряно на сервере.",
    song_changed: "Версия песни на сервере изменилась.",
    incomplete: "Ни одна кривая не дошла до сервера полностью.",
  };
  const mine = $derived(view?.result?.players.find((p) => p.user_id === account.profile?.id) ?? null);
  const theirs = $derived(view?.result?.players.find((p) => p.user_id !== account.profile?.id) ?? null);
  const headline = (r: PlayerResult | null) => (!r ? "" : r.outcome === "win" ? "Победа" : r.outcome === "draw" ? "Ничья" : "Поражение");
  const delta = (r: PlayerResult | null) => (r?.mmr_before != null && r.mmr_after != null ? Math.round(r.mmr_after - r.mmr_before) : null);
  const signedNum = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`;
</script>

<svelte:window {onkeydown} />
<svelte:head><title>Дуэль — Перепев</title></svelte:head>


{#snippet vs()}
  <span class="vs" aria-hidden="true">
    <svg viewBox="0 0 120 120"><polygon points="60,2 72,34 106,18 90,50 118,62 88,74 102,108 70,90 60,118 48,90 16,106 30,74 2,60 32,48 16,16 48,32" fill="#a81d1d" stroke="#0d0c0d" stroke-width="3" stroke-linejoin="round" /></svg>
    <b>VS<small style:display="block" style:font-size="0.3em" style:letter-spacing="0">против</small></b>
  </span>
{/snippet}

{#if !account.profile && account.loaded}
  <section class="pad"><p class="notice">Войди в кабинет, чтобы участвовать в дуэли. <a href={signInHref(page.url.pathname)}>Войти</a></p></section>
{:else if !view || !song}
  <section class="pad">
    {#if error}<p class="notice error" role="alert">{error}</p><a class="btn" href="/duels">К дуэлям</a>{:else}<p class="muted" role="status">Загружаем матч…</p>{/if}
  </section>
{:else if view.state === "created" || view.state === "waiting"}
  <section class="step" class:wide={!(view.kind === "friend" && view.players.length < 2)}>
    <p class="kind">{view.kind === "rated" ? "Рейтинговая дуэль" : "Дуэль с другом, без рейтинга"}</p>
    {#if view.kind === "friend" && view.players.length < 2}
      <TitleStrip text="Ждём друга" />
      <p class="lead">Отправь ссылку на комнату. Песня: {view.song.title}.</p>
      <div class="row">
        <span class="pass"><span class="small">Комната</span><code class="code">{view.room_code}</code></span>
        <button class="btn btn-primary" onclick={copyRoom}>Скопировать ссылку</button>
        {#if copied}<span class="small" role="status">{copied}</span>{/if}
      </div>
      <button class="btn" disabled={leaving} onclick={() => void leave()}>{leaving ? "Выходим…" : "← Выйти из комнаты"}</button>
      <div class="waiting" aria-hidden="true"><Cat mood="sleepy" size={150} /></div>
    {:else}
      <section class="scene duel-scene">
        <div class="at" style:--x="2%" style:--y="3%"><TitleStrip text="Соперник найден" /></div>
        <p class="at kind2" style:--x="4%" style:--y="15%">{view.kind === "rated" ? "Рейтинговая дуэль" : "Дуэль с другом"} · {view.song.title}, {Math.round(view.song.duration_s)} секунд</p>
        <div class="at card self" style:--x="7%" style:--y="20%" style:--w="25%" style:--r="-2deg">
          <span class="tape" aria-hidden="true"></span>
          <span class="who">Ты</span>
          <span class="pic"><Polaroid><Cat mood="idle" size="88%" /></Polaroid></span>
          <b class="name">{me?.name}</b>
          <span class="standing">{me?.standing}</span>
        </div>
        <div class="at vs-wrap" style:--x="40%" style:--y="26%" style:--w="17%">{@render vs()}</div>
        <div class="at card rival" style:--x="63%" style:--y="16%" style:--w="27%" style:--r="2deg">
          <span class="tape" aria-hidden="true"></span>
          <span class="who">Соперник</span>
          <span class="pic"><Polaroid><Cat mood="idle" tint="blue" size="88%" /></Polaroid></span>
          <b class="name">{rival?.name}</b>
          <span class="standing">{rival?.standing}</span>
        </div>
        <div class="at center-actions" style:--x="38%" style:--y="66%" style:--w="21%">
          {#if me?.accepted}
            <p role="status">Ждём подтверждения соперника{left != null ? `, ещё ${left} с` : ""}.</p>
          {:else}
            <button class="btn btn-primary" onclick={() => command({ type: "accept", match_id: view.match_id })}>Принять</button>
            <button class="btn" onclick={() => command({ type: "decline", match_id: view.match_id })}>Отказаться</button>
            {#if left != null}<span class="small muted mono">Осталось {left} с</span>{/if}
          {/if}
        </div>
      </section>
    {/if}
  </section>
{:else if view.state === "ready_check"}
  <section class="step ready">
    <div class="prep">
      <p class="kind">{view.kind === "rated" ? "Рейтинговая дуэль" : "Дуэль с другом, без рейтинга"}</p>
      <TitleStrip text="Подготовка" />
      <ul class="checks sheet">
        <li class:ok={!!song}>Эталон песни «{view.song.title}» загружен</li>
        <li class:ok={micReady}>Микрофон разрешён и звук включён</li>
        <li class:ok={me?.ready}>Готовность отправлена</li>
        <li class:ok={rival?.ready}>{rival?.name ?? "Соперник"} {rival?.ready ? "готов" : "готовится"}</li>
      </ul>
      <div class="row">
        <label class="field mic"><span class="visually-hidden">Устройство ввода</span>
          <select value={mics.selected} disabled={preparing || micReady} onchange={(e) => chooseMic((e.target as HTMLSelectElement).value)}>
            <option value="">Системный микрофон по умолчанию</option>
            {#each mics.devices as d, i (d.deviceId)}<option value={d.deviceId}>{d.label || `Микрофон ${i + 1}`}</option>{/each}
          </select>
        </label>
        <button class="btn" disabled={leaving} onclick={() => void leave()}>← К дуэлям</button>
        <button class="btn btn-primary" disabled={preparing || !!me?.ready} onclick={prepare}>{preparing ? "Подключаем…" : me?.ready ? "Ждём соперника" : "Я готов"}</button>
        {#if left != null}<span class="small muted mono">Осталось {left} с</span>{/if}
      </div>
      <p class="small muted fine">
        Надень наушники. Пауза в живом матче не предусмотрена: общий таймер идёт для обоих. Сопернику и серверу уходит только линия высоты с шагом 50 мс и служебные события; звук остаётся в браузере. Кривые матча хранятся 30 дней для проверки результата.
      </p>
    </div>
    <div class="gear" aria-hidden="true">
      <Cat mood={micReady ? "listening" : "idle"} size={180} />
      {#if micReady}<div class="vu"><VuMeter value={level} label="Уровень микрофона" /></div>{/if}
    </div>
  </section>
{:else if singing || view.state === "collecting"}
  <section class="stage" aria-label="Пение в дуэли">
    <header class="deck">
      <span class="singing-mascot" aria-hidden="true"><Cat mood="singing" size={64} /></span>
      <h1 class="label">{view.song.title}</h1>
      <span class="chip" class:warn={live.status !== "open"} role="status">
        {live.status === "open" ? "Соединение в норме" : "Восстанавливаем соединение, запись идёт"}
      </span>
      <span class="counter mono">{Math.max(0, Math.floor(clock))} / {Math.round(view.song.duration_s)} с</span>
      <button class="key" onclick={() => (exitOpen = true)}><span aria-hidden="true">■</span>Выйти</button>
    </header>
    <div class="roll sheet">
      <PianoRoll {song} frames={() => capture?.frames ?? []} time={() => (capture ? capture.ctx.currentTime - ctxStart : clock)} rival={rivalCurve} {rivalShift} label="Мелодия: эталон, твой голос и соперник пунктиром" />
      {#if view.state === "countdown" && clock < 0}<div class="countdown" aria-live="polite"><span>{Math.ceil(-clock)}</span></div>{/if}
      {#if view.state === "collecting"}
        <div class="overlay">
          <b>Сверяем результаты…</b>
          {#if preliminary != null}<span>Твой предварительный балл {preliminary.toFixed(1)}. Окончательный посчитает сервер.</span>{/if}
          {#if !micReady}<span>Это устройство не записывало попытку.</span>{/if}
        </div>
      {/if}
    </div>
    <div class="legend">
      <span class="l-self">Ты</span>
      <span class="l-rival">{rival?.name}</span>
      <span class="dim mono">Отправлено {sent} из {n} точек{live.pending ? `, в очереди ${live.pending}` : ""}</span>
    </div>
  </section>
{:else if view.state === "finished" && view.result}
  <section class="final">
    <!-- Основная композиция и подробности занимают одно место. -->
    <div class="scene duel-scene" hidden={showDetails}>
      <div class="at" style:--x="2%" style:--y="3%"><TitleStrip text="Дуэль" tag="div" /></div>
      <div class="at headline" style:--x="22%" style:--y="3%"><Cutout tag="h1" text={headline(mine)} size="clamp(34px, 3.4cqi, 64px)" seed={3} /></div>
      <p class="at kind2" style:--x="4%" style:--y="15%">{view.result.rated ? "Рейтинговая дуэль" : "Дуэль с другом, без рейтинга"}{view.result.technical ? ", техническое решение" : ""}</p>
      {#each [{ p: me, r: mine, cls: "self", label: "Ты", x: "7%", y: "20%", w: "25%", rot: "-2deg" }, { p: rival, r: theirs, cls: "rival", label: "Соперник", x: "63%", y: "16%", w: "27%", rot: "2deg" }] as side (side.cls)}
        <article class="at card col {side.cls}" style:--x={side.x} style:--y={side.y} style:--w={side.w} style:--r={side.rot}>
          <span class="tape" aria-hidden="true"></span>
          <span class="who">{side.label}</span>
          <h2 class="name">{side.p?.name}</h2>
          <span class="pic"><Polaroid><Cat mood={side.r?.outcome === "win" ? "happy" : side.r?.outcome === "loss" ? "shy" : "idle"} tint={side.cls === "rival" ? "blue" : "red"} size="88%" /></Polaroid></span>
          <b class="score">{side.r?.score != null ? side.r.score.toFixed(1) : "—"}</b>
        </article>
        <p class="at memo note deco" style:--x={side.cls === "self" ? "19%" : "79%"} style:--y={side.cls === "self" ? "80%" : "79%"} style:--r={side.cls === "self" ? "-6deg" : "5deg"}>
          {side.r?.outcome === "win" ? "хорошая попытка!" : side.r?.outcome === "draw" ? "ничья — споём ещё?" : "в следующий раз будет твой!"}
        </p>
      {/each}
      <div class="at vs-wrap" style:--x="40%" style:--y="26%" style:--w="17%">{@render vs()}</div>
      <div class="at center-actions" style:--x="38%" style:--y="66%" style:--w="21%">
        {#if live.room && live.room.match_id !== view.match_id}
          <a class="btn btn-primary" href="/duels/room/{live.room.code}">Принять реванш</a>
        {:else}
          <button class="btn btn-primary" onclick={again}>{view.kind === "rated" ? "Искать снова" : "Реванш"}</button>
        {/if}
        <a class="btn" href="/duels" onclick={resetMatch}>К дуэлям</a>
        <button class="btn btn-quiet" onclick={() => showDetails = true}>Сравнить по осям</button>
      </div>
      <span class="at deco" style:--x="90%" style:--y="4%" style:--w="4%" style:--r="12deg"><Star variant="print" size="100%" /></span>
      <span class="at deco" style:--x="3%" style:--y="60%" style:--w="3.5%" style:--r="-12deg"><Star variant="outline" size="100%" /></span>
    </div>

    <div class="details" hidden={!showDetails}>
      <div class="details-head"><TitleStrip text="Разбор дуэли" /><button class="btn" onclick={() => showDetails = false}>← К результату</button></div>
      {#if view.result.technical}<p class="notice">{reasons[view.end_reason ?? ""] ?? ""} Неполная кривая не оценивается: результат технический.</p>{/if}
      <div class="axes-row">
        {#each [{ r: mine, cls: "self", label: "Ты" }, { r: theirs, cls: "rival", label: "Соперник" }] as side (side.cls)}
          <div class="axes-card sheet {side.cls}">
            <b>{side.label}</b>
            {#if side.r?.axes}<Axes axes={side.r.axes} compact />{:else}<p class="small muted">Кривая неполная, балл не считается.</p>{/if}
            {#if view.result.rated}
              <p class="small">{side.r?.standing}{delta(side.r) != null ? `, рейтинг ${signedNum(delta(side.r)!)}` : ""}</p>
            {/if}
          </div>
        {/each}
      </div>
      {#if finals}
        <div class="trace sheet graph">
          <ResultTrace
            data={traceSeries(song, finals.myCurve, finals.mine, finals.theirs && finals.theirCurve ? { frames: finals.theirCurve, result: finals.theirs } : null)}
            duration={song.duration_s}
            label="Две линии в твоей тональности: сплошная — ты, пунктир — соперник"
          />
        </div>
      {/if}
      <p class="small muted">Оба участника видят этот же подтверждённый сервером результат.</p>
      {#if live.room && live.room.match_id !== view.match_id}
        <p class="notice">Соперник предлагает реванш. <a class="btn" href="/duels/room/{live.room.code}">Принять реванш</a></p>
      {/if}
    </div>
  </section>
{:else}
  <section class="step failed">
    <div class="fail-cat" aria-hidden="true"><Cat mood="unplugged" size={180} /></div>
    <div class="fail-note sheet">
      <h1>{view.state === "cancelled" ? "Матч отменён" : "Технический сбой"}</h1>
      <p>{reasons[view.end_reason ?? ""] ?? ""} Рейтинг не изменился.</p>
      {#if live.queue?.status === "searching"}<p role="status">Ты снова в поиске с прежним приоритетом.</p>{/if}
      <a class="btn btn-primary" href="/duels" onclick={resetMatch}>К дуэлям</a>
    </div>
  </section>
{/if}

<ConfirmDialog
  open={exitOpen}
  title="Выйти из дуэли?"
  text={view && ["countdown", "singing", "collecting"].includes(view.state) ? "Пение уже началось: выход засчитывается как техническое поражение. Таймер не останавливается." : "Матч будет отменён без изменения рейтинга."}
  confirm="Выйти"
  cancel="Остаться"
  oncancel={() => (exitOpen = false)}
  onconfirm={leave}
/>

<style>
  .pad {
    padding-top: var(--s-8);
  }
  .step {
    position: relative;
    display: grid;
    gap: var(--s-4);
    justify-items: start;
    max-width: 820px;
    padding-top: clamp(var(--s-4), 6vh, var(--s-7));
  }
  .step.wide {
    display: block;
    max-width: none;
    padding-top: 0;
  }
  .step.wide > .kind {
    display: none;
  }
  .kind {
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    color: var(--on-room-2);
  }
  .lead {
    font-size: var(--t-l);
    color: var(--on-room-2);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .pass {
    display: inline-grid;
    padding: 6px var(--s-5) 8px;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-sticker);
    mask: radial-gradient(circle 6px at 0 50%, transparent 97%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle 6px at 100% 50%, transparent 97%, #000) right / 51% 100% no-repeat;
  }
  .pass .small {
    color: var(--ink-2);
  }
  .code {
    font-family: var(--font-mono);
    font-size: var(--t-2xl);
    font-weight: 500;
    letter-spacing: 0.14em;
  }
  .waiting {
    position: absolute;
    right: -220px;
    top: 30%;
  }

  /* Сцена дуэли: карточки на скотче с полароидами, «VS» на звезде-взрыве. */
  .duel-scene {
    width: 100%;
  }
  .kind2 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    color: var(--on-room-2);
  }
  .card {
    display: grid;
    justify-items: center;
    gap: 0.3em;
    padding: 1.2em 1.4em 1em;
    background: #e8dcc2 var(--tex-paper);
    color: var(--ink);
    text-align: center;
    box-shadow: var(--shadow-sheet);
    --muted: var(--ink-2);
  }
  .card .tape {
    left: 38%;
    top: -12px;
  }
  .card.self {
    box-shadow:
      inset 0 5px 0 var(--accent),
      var(--shadow-sheet);
  }
  .card.rival {
    box-shadow:
      inset 0 0 0 2px var(--rival),
      var(--shadow-sheet);
  }
  .who {
    font-family: var(--font-hand);
    font-size: clamp(1.1rem, 1.4cqi, 1.8rem);
    font-weight: 700;
    line-height: 1;
  }
  .pic {
    width: 72%;
    rotate: -2deg;
  }
  .rival .pic {
    rotate: 3deg;
  }
  .name {
    margin: 0;
    font-family: var(--font-hand);
    font-size: clamp(1.3rem, 1.8cqi, 2.3rem);
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1;
  }
  .standing {
    font-size: var(--t-s);
    color: var(--ink-2);
  }
  .score {
    font-family: var(--font-poster);
    font-size: clamp(2.4rem, 3.6cqi, 4.6rem);
    font-weight: 700;
    line-height: 1;
  }
  .self .score {
    color: var(--accent);
  }
  .rival .score {
    color: var(--rival);
  }
  .vs-wrap .vs {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
  .vs {
    position: relative;
    display: grid;
    place-items: center;
    width: 130px;
    height: 130px;
    transform: rotate(-8deg);
    filter: drop-shadow(0 4px 4px rgb(0 0 0 / 0.6));
  }
  .vs svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .vs b {
    position: relative;
    color: var(--marker);
    font-family: var(--font-block);
    font-size: clamp(2rem, 3.6cqi, 4.4rem);
    -webkit-text-stroke: 2px #0d0c0d;
    paint-order: stroke fill;
  }
  .center-actions {
    display: grid;
    gap: var(--s-3);
    justify-items: center;
    text-align: center;
  }
  .memo {
    margin: 0;
    padding: 0.5em 0.8em;
    background-color: var(--paper);
    font-family: var(--font-hand);
    font-size: clamp(1rem, 1.3cqi, 1.6rem);
    font-weight: 700;
    line-height: 1.05;
    max-width: 9em;
  }

  .ready {
    grid-template-columns: minmax(0, 1fr) auto;
    max-width: 1080px;
    align-items: center;
  }
  .prep {
    display: grid;
    gap: var(--s-4);
    justify-items: start;
  }
  /* Чек-лист — записка с квадратиками, отмеченные пункты зачёркнуты галочкой. */
  .checks {
    display: grid;
    gap: var(--s-2);
    margin: 0;
    padding: var(--s-4) var(--s-5);
    list-style: none;
  }
  .checks li {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .checks li::before {
    content: "";
    display: grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border: 2px solid var(--ink);
    border-radius: 2px;
    font-family: system-ui, sans-serif;
    font-size: 15px;
    font-weight: 800;
    line-height: 1;
  }
  .checks li.ok::before {
    content: "✓";
    color: var(--accent);
  }
  .mic select {
    min-width: 280px;
  }
  .fine {
    max-width: 70ch;
  }
  .gear {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
  }
  .vu {
    width: 220px;
  }

  /* Сцена дуэли: та же дека и миллиметровка, что в одиночном пении. */
  .stage {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: var(--s-3);
    height: calc(100dvh - var(--s-6));
    padding-top: var(--s-4);
  }
  .deck {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--s-4);
    padding: 8px var(--s-3) 8px var(--s-4);
    border-radius: 6px;
    background:
      linear-gradient(rgb(255 255 255 / 0.07), transparent 45%),
      var(--tex-metal),
      #2c2b2d;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.12),
      var(--shadow-object);
  }
  .label {
    justify-self: start;
    max-width: 100%;
    padding: 2px var(--s-4) 8px;
    overflow: hidden;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: 0;
    white-space: nowrap;
    text-overflow: ellipsis;
    box-shadow: inset 0 -6px 0 var(--accent);
  }
  .chip {
    padding: var(--s-1) var(--s-3);
    border-radius: 3px;
    background: #121112;
    font-size: var(--t-s);
    color: var(--on-room-2);
  }
  .chip::before {
    content: "●";
    margin-right: var(--s-2);
    color: #79b88e;
  }
  .chip.warn::before {
    content: "◌";
    color: var(--mustard);
  }
  .counter {
    padding: 4px 10px;
    border-radius: 3px;
    background: #0f0e0f;
    color: #e8c46a;
    box-shadow: inset 0 2px 4px rgb(0 0 0 / 0.8);
  }
  .roll {
    position: relative;
    min-height: 280px;
    padding: var(--s-3);
    background-image:
      linear-gradient(rgb(110 150 170 / 0.18) 1px, transparent 1px),
      linear-gradient(90deg, rgb(110 150 170 / 0.18) 1px, transparent 1px),
      var(--tex-paper);
    background-size: 16px 16px, 16px 16px, auto;
    --stage-reference: #bfb399;
    --stage-accent: var(--accent);
    --stage-rival: var(--rival);
    --stage-line: #b7c5cd;
    --stage-ink-2: #6f675d;
  }
  .countdown,
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--s-2);
    text-align: center;
    color: var(--ink);
  }
  .countdown span {
    display: grid;
    place-items: center;
    width: 9rem;
    height: 9rem;
    border: 5px solid var(--accent);
    border-radius: 50%;
    color: var(--accent);
    font-family: var(--font-hand);
    font-size: 7rem;
    font-weight: 700;
    line-height: 1;
    transform: rotate(-8deg);
    background: rgb(245 240 230 / 0.75);
  }
  .overlay {
    background: rgb(245 240 230 / 0.85);
  }
  .overlay b {
    font-family: var(--font-hand);
    font-size: 2.4rem;
    line-height: 1;
  }
  .legend {
    display: flex;
    gap: var(--s-5);
    font-size: var(--t-s);
  }
  .dim {
    color: var(--on-room-2);
  }
  .l-self::before,
  .l-rival::before {
    content: "";
    display: inline-block;
    width: 22px;
    height: 4px;
    margin-right: var(--s-2);
    vertical-align: middle;
  }
  .l-self::before {
    background: var(--accent-bright);
  }
  .l-rival::before {
    background: repeating-linear-gradient(90deg, var(--rival-bright) 0 6px, transparent 6px 10px);
  }

  .final {
    display: grid;
    gap: var(--s-4);
    padding-bottom: 0;
  }
  .details {
    height: calc(100svh - var(--chrome));
    overflow-y: auto;
    overscroll-behavior: contain;
    align-content: start;
    display: grid;
    gap: var(--s-3);
  }
  .singing-mascot { width: 64px; height: 50px; overflow: hidden; }
  .details-head { display: flex; align-items: center; justify-content: space-between; }
  .axes-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-4);
  }
  .axes-card {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-5);
  }
  .axes-card.self {
    box-shadow:
      inset 0 4px 0 var(--accent),
      var(--shadow-sheet);
  }
  .axes-card.rival {
    box-shadow:
      inset 0 0 0 2px var(--rival),
      var(--shadow-sheet);
  }
  .trace {
    height: 110px;
    padding: var(--s-2) var(--s-3);
  }

  .failed {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    max-width: 900px;
  }
  .fail-note {
    display: grid;
    gap: var(--s-3);
    justify-items: start;
    padding: var(--s-5) var(--s-6);
  }
  .fail-note h1 {
    font-family: var(--font-hand);
    font-size: 2.4rem;
    letter-spacing: 0;
  }
  @media (max-width: 1099px) {
    .waiting {
      display: none;
    }
  }
  /* Не wide: сцена дуэли и итог идут потоком (общее правило .scene в base.css). */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .details { height: auto; overflow: visible; }
    .versus,
    .cols,
    .ready,
    .final {
    display: grid;
    gap: var(--s-3);
    padding-top: var(--s-3);
  }
  .final-head {
    display: flex;
    align-items: center;
    gap: var(--s-3) var(--s-5);
    flex-wrap: wrap;
    padding-left: var(--s-4);
  }
  .final-head .muted {
    flex-basis: 100%;
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 380px) auto minmax(0, 380px);
    justify-content: center;
    align-items: start;
    gap: var(--s-5);
  }
  .col h2 {
    font-family: var(--font-hand);
    font-size: 1.9rem;
    letter-spacing: 0;
    line-height: 1;
  }
  .col-mid {
    display: flex;
    align-items: center;
    gap: var(--s-5);
  }
  .col :global(.axes) {
    width: 100%;
    text-align: left;
  }
  .score {
    font-family: var(--font-poster);
    font-size: 3.4rem;
    font-weight: 700;
    line-height: 1;
  }
  .self .score {
    color: var(--accent);
  }
  .rival .score {
    color: var(--rival);
  }
  .memo {
    position: absolute;
    bottom: -26px;
    right: -18px;
    padding: 6px 12px 8px;
    background-color: var(--paper-2);
    font-family: var(--font-hand);
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1;
    transform: rotate(-5deg);
  }
  .center {
    display: grid;
    justify-items: center;
    gap: var(--s-5);
    padding-top: var(--s-8);
  }
  .center-actions {
    display: grid;
    gap: var(--s-3);
    justify-items: center;
  }
  .trace {
    height: 100px;
    margin-top: var(--s-4);
    padding: var(--s-2) var(--s-3);
  }

  .failed {
      grid-template-columns: 1fr;
    }
    .vs {
      justify-self: center;
    }
    .gear,
    .fail-cat {
      display: none;
    }
    .deck {
      grid-template-columns: 1fr auto;
    }
  }
</style>
