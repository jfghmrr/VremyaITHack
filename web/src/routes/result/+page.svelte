<script lang="ts">
  import { goto } from "$app/navigation";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { last } from "#lib/session.svelte.ts";
  import { account } from "#lib/api/account.svelte.ts";
  import { canonical, correction, outcome, score } from "#lib/scoring/index.svelte.ts";
  import type { CorrectionPoint, Moment, Outcome, ScoreResult } from "#lib/scoring/types.ts";
  import { Playback, type IdealEngine } from "#lib/audio/playback.ts";
  import { GUIDE_RATE, guideSegments, guideShift, renderGuide } from "#lib/audio/guide.ts";
  import { encodeChallenge } from "#lib/challenge/codec.ts";
  import { saving, retrySave } from "#lib/history.svelte.ts";
  import ResultTrace from "#lib/ui/ResultTrace.svelte";
  import { traceSeries } from "#lib/ui/series.ts";
  import { modified, typing } from "#lib/ui/keys.ts";
  import { reducedMotion } from "#lib/ui/canvas.ts";
  import { plural, signed } from "#lib/ui/format.ts";
  import Cat from "#lib/brand/Cat.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  import ScoreSeal from "#lib/brand/ScoreSeal.svelte";
  import Star from "#lib/brand/Star.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Decor from "#lib/brand/Decor.svelte";
  import PreciseBadge from "#lib/precise/PreciseBadge.svelte";
  import SharePopover from "#lib/ui/SharePopover.svelte";
  import { merged, precise } from "#lib/precise/attempt.svelte.ts";

  const song = last.song;
  const result = last.result;
  const frames = last.frames;

  let curve = $state<CorrectionPoint[] | null>(null);
  let engine = $state<IdealEngine>("synth");
  let ideal = $state(false);
  let playing = $state<null | "all" | number>(null);
  let busy = $state(false);
  let error = $state("");
  let shown = $state(0);
  let elapsed = $state(0);
  let preparing = $state(true);
  let curveError = $state("");
  let raf = 0;
  const clockText = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  let showAnalysis = $state(!!last.ghost);
  // compact: переключатель «Итог | Разбор и ошибки» есть в обоих разделах, и нажатая кнопка
  // прячется вместе со своим разделом. Фокус переходит на ту же кнопку в открывшемся разделе,
  // а не падает на <body> (клавиатура, экранный диктор).
  async function showView(analysis: boolean) {
    showAnalysis = analysis;
    await tick();
    document.querySelector<HTMLButtonElement>(analysis ? "#analysis .view-switch button:last-child" : ".result-summary .view-switch button:first-child")?.focus();
  }
  let name = $state(account.profile?.name ?? "");
  let duel = $state<{ you: ScoreResult; rival: ScoreResult; outcome: Outcome } | null>(null);
  let playback: Playback | null = null;
  let ticket = 0;

  // Балл и оси: предварительные из браузера, затем окончательные с проверкой слов.
  const view = $derived(result ? merged(result, precise.result) : null);
  // С призраком на графике и его линия (пунктир), перенесённая в твою тональность.
  const data = $derived(song && result ? traceSeries(song, frames, result, duel && last.ghost ? { frames: last.ghost.curve, result: duel.rival } : null) : []);
  const fragment = $derived(typeof playing === "number" && result ? result.moments[playing] : null);

  onMount(() => {
    if (!song || !result) return;
    void prepare();
    const tick = () => { if (playback) elapsed = playback.position; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    if (last.ghost) void scoreDuel();
  });

  // Счётчик балла: движение при появлении результата и при переходе к окончательному баллу.
  let counter = 0;
  $effect(() => {
    const target = view?.score;
    if (target === undefined) return;
    const from = untrack(() => shown);
    const start = performance.now();
    const run = ++counter;
    const step = (now: number) => {
      if (run !== counter) return;
      const t = reducedMotion() ? 1 : Math.min(1, (now - start) / 800);
      shown = from + (target - from) * (1 - (1 - t) ** 3);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  onDestroy(() => { stop(); cancelAnimationFrame(raf); });

  async function prepare() {
    if (!song || !result) return;
    preparing = true; curveError = "";
    try { curve = await correction(frames, song, result); }
    catch { curveError = "Не удалось подготовить исправленный голос. Запись и синтезированный ориентир можно слушать."; }
    finally { preparing = false; }
  }
  // Синтезированный ориентир считается один раз, при первом прослушивании.
  let guide: { samples: Float32Array<ArrayBuffer>; rate: number } | null = null;
  function guideAudio() {
    if (!guide && song && result)
      guide = { samples: renderGuide(guideSegments(song.f0_midi, song.hop_ms / 1000, guideShift(result)), song.duration_s, GUIDE_RATE, song.hop_ms / 1000), rate: GUIDE_RATE };
    return guide ?? undefined;
  }
  // Синтезированному ориентиру поправка высоты не нужна: он строится по эталону и общей тональности.
  const needsCurve = $derived(ideal && engine === "voice");
  const canPlay = $derived(!!last.recording && !!last.backing && (!needsCurve || !!curve));

  // Дуэль с призраком: обе линии на одной сетке 50 мс оцениваются одной функцией.
  async function scoreDuel() {
    if (!song || !last.ghost) return;
    const mine = await canonical(frames, song.duration_s);
    const [you, rival] = await Promise.all([score(mine, song), score(last.ghost.curve, song)]);
    duel = { you, rival, outcome: await outcome(you.score, rival.score) };
  }

  function stop() {
    ticket++;
    busy = false;
    playback?.stop();
    playback = null;
    playing = null;
    elapsed = 0;
  }

  async function play(part: null | number = null) {
    if (!song || !result) return;
    if (!last.recording || !last.backing) { error = "Запись недоступна. Спой фрагмент ещё раз."; return; }
    if (ideal && engine === "voice" && !curve) { error = "Исправленный голос ещё не готов. Послушай запись или повтори подготовку."; return; }
    stop();
    const t = ++ticket;
    busy = true;
    error = "";
    const m = part === null ? null : result.moments[part];
    if (m) ideal = false;
    try {
      const p = await Playback.create({
        recording: last.recording,
        backing: last.backing,
        duration: song.duration_s,
        result,
        curve: curve ?? [],
        guide: engine === "synth" ? guideAudio() : undefined,
        engine,
        ideal: m ? false : ideal,
        from: m ? Math.max(0, m.start_s - 0.3) : 0,
        to: m ? Math.min(song.duration_s, m.end_s + 0.3) : song.duration_s,
        onEnd: () => { if (t === ticket) { playing = null; elapsed = 0; playback = null; } },
      });
      if (t !== ticket) return p.stop();
      playback = p;
      p.setIdeal(m ? false : ideal);
      playing = part === null ? "all" : part;
    } catch (e) {
      error = `Не удалось запустить звук: ${(e as Error).message}. Попробуй синтезированный ориентир.`;
    } finally {
      if (t === ticket) busy = false;
    }
  }

  function setIdeal(value: boolean) {
    ideal = value;
    if (busy) return;
    if (typeof playing === "number") { stop(); void play(); }
    else if (playback) playback.setIdeal(value);
    else void play();
  }

  function practice(i: number) {
    stop();
    void goto(`/practice?m=${i}`);
  }

  /** Ссылка-вызов: призрак этой попытки под именем who. */
  async function challengeLink(who: string) {
    if (!song || !result) throw new Error("Нет попытки для вызова. Спой песню ещё раз.");
    const fragment = encodeChallenge({
      v: 1,
      songId: song.id,
      name: who.trim() || "Соперник",
      shift: result.shift,
      score: result.score,
      curve: await canonical(frames, song.duration_s),
    });
    return `${location.origin}/${fragment}`;
  }

  function onkeydown(e: KeyboardEvent) {
    if (modified(e) || typing(e) || !song) return;
    if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === "к") {
      e.preventDefault();
      stop();
      void goto(`/sing/${song.id}`);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      stop();
      void goto("/songs");
    }
  }

  const reasonLabel = (m: Moment) => (m.reason === "missing" ? "Пропуск" : m.reason === "rhythm" ? "Ритм" : "Высота");
  const momentText = (m: Moment) =>
    m.text.includes("на 0 центов") ? `Во фразе ${m.phrase} высота колебалась вокруг мелодии. Переслушай этот момент.` : m.text;
  const title = $derived(
    !view ? "" : view.axes.coverage < 0.3 ? "Голоса почти не слышно." : view.score >= 85 ? "Чисто." : view.score >= 60 ? "Хорошая попытка." : "Есть над чем поработать.",
  );
  // Реакция кота: радость, «класс», смущение или комичная слеза — без насмешки.
  const mood = $derived(!view ? "idle" : view.axes.coverage < 0.3 ? "tear" : view.score >= 85 ? "happy" : view.score >= 60 ? "thumbs" : "shy");

  const metricNames = $derived<[keyof ScoreResult["axes"], string][]>([
    ["intervals", "Интервалы"],
    ["rhythm", precise.result?.wordsChecked ? "Ритм и слова" : "Ритм"],
    ["stability", "Устойчивость"],
    ["coverage", "Покрытие"],
  ]);
  const cheer = $derived(mood === "happy" ? "так держать!" : mood === "thumbs" ? "ты можешь больше!" : mood === "shy" ? "в следующий раз получится!" : "пой ближе к микрофону");
  const outcomeText = (o: Outcome, rival: string) => (o === "draw" ? "Ничья" : o === "win" ? "Ты впереди" : `${rival} впереди`);
</script>

<svelte:window {onkeydown} />
<svelte:head><title>Разбор — Перепев</title></svelte:head>

{#if !song || !result}
  <!-- Расстановка повторяет мокап «Пока тут пусто…». -->
  <section class="scene fit empty">
    <div class="at" style:--x="2%" style:--y="var(--title-top)"><TitleStrip text="Пока тут пусто…" /></div>
    <div class="at empty-note sheet" style:--x="20%" style:--y="14%" style:--w="52%" style:--r="-1deg">
      <h2>Разбора пока нет.</h2>
      <p>Запись живёт только в открытой вкладке. Спой песню, и разбор появится здесь.</p>
      <a class="btn btn-primary" href="/songs">К выбору песен</a>
    </div>
    <p class="at side-note deco" style:--x="76%" style:--y="9%" style:--w="14%" style:--r="4deg">все начинают с первой песни &lt;3</p>
    <!-- Кот спит на сундуке: одна наклейка, кот стоит на крышке, а не висит в воздухе. -->
    <span class="at deco sleeper" style:--x="24%" style:--y="57%" style:--w="32%">
      <span class="sleeper-cat"><Cat mood="lying" size="100%" /></span>
      <span class="trunk"><i class="strap"></i><i class="strap"></i><i class="label"></i></span>
    </span>
    <span class="at deco" style:--x="71%" style:--y="55%" style:--w="25%"><Decor kind="cases" width="100%" /></span>
    <span class="at deco" style:--x="8%" style:--y="44%" style:--w="5%" style:--r="-12deg"><Star variant="patch" size="100%" /></span>
    <span class="at deco" style:--x="66%" style:--y="64%" style:--w="3.6%" style:--r="10deg"><Star variant="patch" size="100%" /></span>
    <span class="at deco" style:--x="16%" style:--y="62%" style:--w="3%"><Decor kind="notes" width="100%" /></span>
  </section>
{:else}
  <!-- compact: переключатель «Итог | Разбор и ошибки» сразу под заголовком, а не в панели
       прослушивания в конце длинной страницы. На широких экранах — кнопка в панели, как раньше. -->
  {#snippet viewSwitch()}
    <div class="segmented view-switch" role="group" aria-label="Что показать">
      <button type="button" aria-pressed={!showAnalysis} onclick={() => void showView(false)}>Итог</button>
      <button type="button" aria-pressed={showAnalysis} aria-controls="analysis" onclick={() => void showView(true)}>Разбор и ошибки</button>
    </div>
  {/snippet}
  <div class="result">
    <section class="result-summary" aria-label="Итог" hidden={showAnalysis}>
      <header class="result-heading"><TitleStrip text="Результат" fastener="binder" /><p>{song.title}{last.ghost ? ` · против ${last.ghost.name}` : ""}</p></header>
      {@render viewSwitch()}
      <div class="result-grid">
        <div class="score-card sheet">
          <span class="fastener" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={24} /></span>
          <span class="eyebrow">Твоё исполнение</span>
          <ScoreSeal><span class="score"><span class="big" aria-label="{(view ?? result).score.toFixed(1)} из 100">{Math.round(shown)}</span><span class="of">/100</span></span></ScoreSeal>
          <PreciseBadge />
          <h2 class="verdict">{title}</h2>
          <div class="score-actions"><a class="btn btn-ink" href="/sing/{song.id}" onclick={stop}>Ещё раз <kbd>R</kbd></a><SharePopover make={challengeLink} askName={!account.profile} bind:name placement="side" /></div>
        </div>
        <div class="companion"><Cat {mood} size="100%" /><p class="encouragement">{cheer}</p></div>
        <div class="metrics sheet">
          <span class="fastener" aria-hidden="true"><Asset name="hardware/binder-clip-s03" width={34} /></span>
          <h2>Как это звучало</h2>
          <dl>
            {#each metricNames as [key, label] (key)}
              <div class="metric"><dt>{label}</dt><dd>{Math.round((view ?? result).axes[key] * 100)}</dd><span class="meter" aria-hidden="true"><i style:width={`${(view ?? result).axes[key]*100}%`}></i></span></div>
            {/each}
          </dl>
          <p class="shift"><span>Тональный сдвиг</span><strong>{signed(result.shift)} {plural(Math.abs(Math.round(result.shift)), ["полутон", "полутона", "полутонов"])}</strong><span class="no-penalty">без штрафа</span></p>
          <p class="caption">{(view ?? result).axes.coverage < 0.3 ? "Слишком мало голоса для оценки. Проверь микрофон и попробуй ещё раз." : precise.result?.wordsChecked ? "Оценка мелодии, ритма и слов в твоей тональности." : "Оценка мелодии и ритма в твоей тональности."}</p>
        </div>
      </div>
    </section>

    {#if saving.error}
      <p class="notice error" role="alert">
        {saving.error}
        <button class="btn" disabled={saving.busy} onclick={() => void retrySave()}>Повторить сохранение</button>
      </p>
    {/if}

    <section class="detail" id="analysis" aria-label="Разбор" hidden={!showAnalysis}>
      {@render viewSwitch()}
      <div class="chart sheet graph">
        <div class="analysis-title"><div><h2>Разбор: {song.title}</h2><p class="small">Мелодия в твоей тональности</p></div><Cat {mood} size={90} /></div>
        <div class="trace">
          <ResultTrace
            {data}
            duration={song.duration_s}
            {ideal}
            window={fragment ? [fragment.start_s, fragment.end_s] : null}
            label={ideal ? "Идеальная высота в твоей тональности" : "Линия голоса: сплошная — точно, тонкая — неточно, штрих — ошибка"}
          />
        </div>
        <div class="scale mono"><span>0:00</span><span>{Math.round(song.duration_s)} сек</span></div>
        {#if duel && last.ghost}
          <div class="duel">
            <p class="duel-title"><b>{outcomeText(duel.outcome, last.ghost.name)}</b> <span class="small">Дуэль с призраком: рейтинг не меняется</span></p>
            <div class="duel-cols">
              <div><span class="small">Ты</span><b class="self">{duel.you.score.toFixed(1)}</b></div>
              <div><span class="small">{last.ghost.name}</span><b class="rival">{duel.rival.score.toFixed(1)}</b></div>
            </div>
            <p class="small">Обе линии пересчитаны на сетке 50 мс, поэтому балл может немного отличаться от подробного разбора.</p>
          </div>
        {/if}
      </div>
      <div class="notes sheet">
        <h2 class="moments-title">{result.moments.length ? "Что улучшить" : "Заметных потерь нет"}</h2>
        {#if result.constantTone}
          <p class="notice">Почти одна нота всю попытку. Повтори движение мелодии вверх и вниз.</p>
        {/if}
        <ol class="moments">
          {#each result.moments as m, i (m.start_s)}
            <li class:active={playing === i}>
              <span class="when"><span class="mono">{m.start_s.toFixed(1)}–{m.end_s.toFixed(1)} с</span> <span class="tag">{reasonLabel(m)}</span></span>
              <p>{momentText(m)}</p>
              <div class="m-actions">
                <button class="btn" disabled={busy || !last.recording || !curve} onclick={() => (playing === i ? stop() : void play(i))}>{playing === i ? "Остановить" : "Переслушать"}</button>
                <button class="btn btn-quiet" onclick={() => practice(i)}>Потренировать</button>
              </div>
            </li>
          {/each}
        </ol>
      </div>
    </section>

    <footer class="bar" aria-label="Прослушивание и разбор">
      <div class="playback-heading"><span class="eyebrow">Сравни звучание</span><button class="btn analysis-button" aria-controls="analysis" aria-expanded={showAnalysis} onclick={() => showAnalysis = !showAnalysis}>{showAnalysis ? "← К результату" : "Разбор и ошибки"}</button>{#if showAnalysis}<SharePopover make={challengeLink} askName={!account.profile} bind:name placement="above" />{/if}</div>
      <div class="playback-controls">
        <button class="key rec play" disabled={busy || !canPlay} aria-label={playing === "all" ? "Остановить" : "Слушать попытку"} aria-pressed={playing === "all"} onclick={() => (playing === "all" ? stop() : void play())}><span aria-hidden="true">{playing === "all" ? "■" : "▶"}</span><span>{busy ? "Готовим…" : playing === "all" ? "Стоп" : "Слушать"}</span></button>
        <div class="playback-clock"><span class="mono">{clockText(elapsed)} / {clockText(song.duration_s)}</span><progress aria-label="Воспроизведение записи" max={song.duration_s} value={elapsed}></progress></div>
        <div class="segmented" role="group" aria-label="Что звучит">
          <button disabled={busy || !last.recording} aria-pressed={!ideal} onclick={() => setIdeal(false)}>Как пел</button>
          <button disabled={busy || (engine === "voice" && !curve)} aria-pressed={ideal} onclick={() => setIdeal(true)}>{engine === "synth" ? "Ориентир" : "Мой голос, исправленный"}</button>
        </div>
        <label class="engine"><span>Источник ориентира</span><select bind:value={engine} onchange={stop}><option value="synth">Синтезированный голос</option><option value="voice">Мой голос (эксперимент)</option></select></label>
      </div>
      <p class="honest">{preparing ? "Готовим ориентир… Запись уже можно слушать." : engine === "synth" ? "Ориентир показывает мелодию в твоей тональности. Нажми «Как пел» или «Ориентир», чтобы услышать разницу." : "Обработанная запись: возможны искажения, ритм и пропуски не исправляются."}</p>
      {#if curveError}<div class="player-message" role="alert"><span>{curveError}</span><button class="btn" disabled={preparing} onclick={prepare}>Повторить</button></div>{/if}
      {#if error}<div class="player-message" role="alert"><span>{error}</span><button class="dismiss" aria-label="Закрыть сообщение" onclick={() => (error = "")}>×</button></div>{/if}
    </footer>
  </div>
{/if}

<style>
  /* Пустое состояние: рваная записка с действием, кот спит на сундуке, стопка кейсов. */
  .empty-note {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
    padding: var(--s-6) var(--s-6) var(--s-5);
    text-align: center;
    clip-path: polygon(0 3%, 8% 0, 30% 2%, 55% 0, 80% 3%, 100% 0, 99% 50%, 100% 97%, 70% 100%, 40% 97%, 12% 100%, 0 98%, 1% 50%);
  }
  .empty-note h2 {
    margin: 0;
    font-size: clamp(1.4rem, 1.9cqi, 2.3rem);
  }
  .empty-note p {
    margin: 0;
    color: var(--ink-2);
  }
  .side-note {
    margin: 0;
    padding: 1em 0.8em;
    background: #1d1c1d var(--tex-paper);
    color: var(--paper);
    font-family: var(--font-hand);
    font-size: clamp(1.3rem, 2cqi, 2.4rem);
    font-weight: 700;
    line-height: 1;
    text-align: center;
    text-transform: uppercase;
    box-shadow: var(--shadow-sheet);
  }
  .sleeper {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .sleeper-cat {
    position: relative;
    z-index: 1;
    width: 78%;
    margin-bottom: -5%;
  }
  /* Сундук: тёмная кожа, латунные уголки, два ремня и пустая бумажная бирка. */
  .trunk {
    position: relative;
    width: 100%;
    aspect-ratio: 3.4;
    border: 3px solid #0d0c0d;
    border-radius: 10px 10px 4px 4px;
    background:
      radial-gradient(circle at 7px 7px, #c99a2e 0 5px, transparent 6px) 0 0 / 50% 50% no-repeat,
      linear-gradient(180deg, rgb(255 255 255 / 0.08), transparent 18%, transparent 30%, rgb(0 0 0 / 0.35) 31%, transparent 34%),
      var(--tex-metal),
      #2b2321;
    box-shadow: var(--shadow-object), inset 0 0 0 4px #1b1514;
  }
  .trunk::before,
  .trunk::after {
    content: "";
    position: absolute;
    bottom: 6px;
    width: 18px;
    height: 18px;
    border: 3px solid #a07a26;
    background: #c99a2e;
  }
  .trunk::before {
    left: 6px;
    border-radius: 0 0 0 6px;
  }
  .trunk::after {
    right: 6px;
    border-radius: 0 0 6px 0;
  }
  .strap {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7%;
    background: linear-gradient(90deg, #3d2a1c, #5a3d27 45%, #3d2a1c);
    box-shadow: inset 0 0 0 1px #1b1210;
  }
  .strap:first-child {
    left: 22%;
  }
  .strap:nth-child(2) {
    right: 22%;
  }
  .label {
    position: absolute;
    left: 41%;
    top: 42%;
    width: 18%;
    height: 30%;
    background: var(--paper) var(--tex-paper);
    rotate: -3deg;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.5);
  }

  .result { display: grid; grid-template-rows: minmax(0,1fr) auto; gap: 16px; height: calc(100svh - var(--chrome)); position: relative; }
  .result-summary { display: grid; grid-template-rows: auto minmax(0,1fr); gap: 18px; padding: var(--title-top) 2% 8px; min-height: 0; }
  .result-heading { display: flex; align-items: center; gap: 28px; }
  .result-heading p { color: var(--on-room-2); font-size: 15px; }
  .result-grid { display: grid; grid-template-columns: 1fr .7fr 1fr; gap: 24px; align-items: center; min-height: 0; }
  .score-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px; text-align: center; }
  .fastener { position: absolute; right: 24px; top: -22px; rotate: 9deg; }
  .eyebrow { font: 500 11px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
  .score { display: grid; justify-items: center; gap: 3px; color: var(--paper-2); }
  .big { font: 700 58px/.95 var(--font-poster); }
  .of { font: 500 17px/1 var(--font-poster); }
  .verdict { font: 700 clamp(23px,2.2vw,32px)/1.05 var(--font-hand); margin: 0; }
  .score-actions { display: flex; gap: 10px; margin-top: 8px; justify-content: center; flex-wrap: wrap; }
  .score-actions .btn { min-height: 36px; padding: 4px 14px; }
  .companion { align-self: center; text-align: center; }
  .companion :global(.cat) { max-width: 250px; margin: 0 auto; }
  .encouragement { font: 600 24px/1.1 var(--font-hand); color: var(--paper); margin: 12px auto 0; max-width: 200px; }
  .metrics { padding: 22px 24px; }
  .metrics h2 { font: 700 26px/1.1 var(--font-hand); margin-bottom: 18px; }
  .metrics dl { display: grid; gap: 14px; margin: 0; }
  .metric { display: grid; grid-template-columns: 1fr auto; gap: 6px; font-size: 14px; }
  .metric dd { margin: 0; font-weight: 700; }
  .meter { grid-column: 1/-1; height: 4px; background: #d3cab7; border-radius: 2px; overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--accent); }
  .shift { display: grid; grid-template-columns: 1fr auto; gap: 4px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--rule); font-size: 13px; }
  .no-penalty { color: #416b43; font-size: 12px; }
  .caption { margin-top: 12px; font-size: 12px; color: var(--ink-2); }
  .result > .notice { position: absolute; bottom: 140px; left: 0; right: 0; z-index: 10; }
  .analysis-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  .analysis-title h2 { font: 700 2rem/1 var(--font-hand); }
  /* Разбор: график на миллиметровке и тетрадный лист с замечаниями. */
  .detail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: var(--s-4);
    align-items: stretch;
    min-height: 0;
  }
  .chart {
    padding: var(--s-3) var(--s-4) var(--s-2);
  }
  .trace {
    height: 180px;
  }
  .scale {
    display: flex;
    justify-content: space-between;
    margin-top: var(--s-1);
    font-size: 0.72rem;
    color: var(--ink-3);
  }
  .duel {
    display: grid;
    gap: var(--s-1);
    margin-top: var(--s-2);
    padding-top: var(--s-2);
    border-top: 1px dashed var(--line-strong);
  }
  .duel-title .small,
  .duel .small {
    color: var(--ink-2);
  }
  .duel-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-4);
  }
  .duel-cols div {
    display: grid;
  }
  .duel-cols b {
    font-family: var(--font-poster);
    font-size: var(--t-xl);
  }
  .self {
    color: var(--accent);
    text-decoration: underline 3px;
    text-underline-offset: 4px;
  }
  .rival {
    color: var(--rival);
    text-decoration: underline dashed 3px;
    text-underline-offset: 4px;
  }
  .notes {
    max-height: 100%;
    min-height: 0;
    overscroll-behavior: contain;
    overflow: auto;
    padding: var(--s-2) var(--s-5) var(--s-2) var(--s-7);
    background-image:
      linear-gradient(90deg, transparent 2.6rem, var(--margin) 2.6rem, var(--margin) calc(2.6rem + 1px), transparent calc(2.6rem + 1px)),
      var(--tex-paper);
  }
  .moments-title {
    font-family: var(--font-hand);
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: 0;
    border-bottom: 1px solid var(--rule);
  }
  .moments {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .moments li {
    display: grid;
    grid-template-columns: 1fr;
    align-items: center;
    gap: var(--s-3);
    min-height: 3.2rem;
    padding: var(--s-3) 0;
    border-bottom: 1px solid var(--rule);
  }
  .moments li.active {
    background: linear-gradient(100deg, transparent, rgb(242 215 78 / 0.55) 2%, rgb(242 215 78 / 0.45) 98%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
    padding-left: var(--s-3);
  }
  .moments p {
    font-size: var(--t-s);
  }
  .when {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: var(--t-xs);
    color: var(--ink-2);
  }
  /* Причина — штамп: рамка и наклон, а не только цвет. */
  .tag {
    padding: 0 6px;
    border: 1.5px solid var(--accent);
    border-radius: 2px;
    color: var(--accent);
    font-weight: 700;
    transform: rotate(-3deg);
  }
  .m-actions {
    display: flex;
    gap: var(--s-1);
  }
  .m-actions .btn {
    min-height: 32px;
    font-size: var(--t-s);
  }

  /* Тост достижения на широком экране — справа сверху, а не поверх панели прослушивания. */
  @media (min-width: 1100px) and (min-height: 521px) {
    :global(body:has(.result .bar) .toast-region) { top: 76px; bottom: auto; }
  }
  .bar { padding: 12px 18px; border: 1px solid #504b40; border-radius: 5px; background: #1f1d1a; box-shadow: 0 5px 18px #0005; }
  /* «← К результату» и «Поделиться» — кнопки: на узком телефоне «Поделиться» переходит на вторую строку. */
  .playback-heading { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 10px 14px; margin-bottom: 10px; }
  .playback-heading .eyebrow { color: #c9c1ad; margin-right: auto; }
  .analysis-button { min-height: 36px; }
  .playback-controls { display: flex; align-items: center; gap: 18px; }
  /* «Слушать» — красная клавиша деки (.key.rec), как запись на сцене пения. */
  .play { min-width: 112px; font-size: 14px; }
  .playback-clock { display: grid; gap: 6px; min-width: 110px; font-size: 11px; }
  progress { width: 100%; height: 4px; accent-color: #d2ba85; }
  .engine { display: grid; gap: 3px; font-size: 11px; color: #c4bdad; margin-left: auto; }
  .engine select { min-height: 32px; max-width: 230px; padding: 3px 7px; background: #292720; border: 1px solid #615b4e; color: var(--paper); font-size: 12px; }
  .honest { margin-top: 10px; font-size: 11px; color: #c4bdad; }
  .player-message { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 8px 12px; background: var(--paper); color: var(--ink); font-size: 13px; }
  .dismiss { margin-left: auto; background: none; color: var(--ink); border: 0; font-size: 24px; min-width: 32px; min-height: 32px; }
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 800px) { .result-summary { gap: 6px; padding-top: 14px; } .score-card { gap: 8px; padding: 14px 18px; } .metrics { padding: 18px 22px; } .metrics dl { gap: 10px; } .companion :global(.cat) { max-width: 200px; } }
  /* Сенсорный экран или не wide: цели нажатия не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .score-actions .btn, .m-actions .btn { min-height: var(--tap); }
    .play, .engine select, .analysis-button { min-height: var(--tap); }
    .engine select { height: var(--tap); }
    .dismiss { min-width: var(--tap); min-height: var(--tap); }
  }
  /* Не wide: итог и панель прослушивания идут потоком. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .result { height: auto; grid-template-rows: auto auto; padding-bottom: var(--s-4); }
    .result-summary { padding: var(--s-5) 0 0; gap: var(--s-6); }
    .result-heading { flex-wrap: wrap; gap: 12px; }
    .result-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--s-5); align-items: start; }
    .companion { display: none; }
    .detail { grid-template-columns: minmax(0, 1fr); }
    .notes { max-height: none; }
    .result > .notice { position: static; }
    .playback-controls { flex-wrap: wrap; gap: 12px; }
    .engine { margin-left: 0; }
    .bar { padding: 12px; }
  }
  .view-switch { display: none; }
  /* compact: одна колонка; «Итог | Разбор и ошибки» вверху вместо кнопки в панели. */
  @media (max-width: 599px) {
    .view-switch { display: flex; }
    .analysis-button { display: none; }
    .detail > .view-switch { margin-top: var(--title-top); }
    .result-grid { grid-template-columns: minmax(0, 1fr); gap: var(--s-6); }
    .engine, .engine select { width: 100%; max-width: none; }
    .segmented { width: 100%; }
    .segmented > button { flex: 1; }
  }
  /* Не wide: пустой результат начинается на той же высоте под шапкой, что остальные страницы. */
  @media not all and (min-width: 1100px) and (min-height: 521px) { .scene.empty { padding-top: var(--title-top); } }
</style>
