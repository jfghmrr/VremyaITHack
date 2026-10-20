<script lang="ts">
  // Тренировка сложного фрагмента: без оценки и без сохранения записи.
  // «По кругу» повторяет фрагмент, пока не остановишь.
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import { Capture, micError } from "#lib/audio/capture.ts";
  import { mics } from "#lib/audio/microphones.svelte.ts";
  import { last } from "#lib/session.svelte.ts";
  import { stage } from "#lib/ui/stage.svelte.ts";
  import PianoRoll from "#lib/ui/PianoRoll.svelte";
  import type { PitchFrame } from "#lib/scoring/types.ts";
  import Cat from "#lib/brand/Cat.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";

  const song = last.song;
  const index = Number(page.url.searchParams.get("m") ?? 0);
  const moment = last.result?.moments[index] ?? null;
  const from = moment ? Math.max(0, moment.start_s - 0.3) : 0;
  const to = moment && song ? Math.min(song.duration_s, moment.end_s + 0.3) : 0;

  let running = $state(false);
  let busy = $state(false);
  let loop = $state(false);
  let error = $state("");
  let clock = $state(from);
  let mic: Capture | null = null;
  let source: AudioBufferSourceNode | null = null;
  const points: PitchFrame[] = [];
  let begin = 0;
  let raf = 0;
  let ticket = 0;

  stage.dark = true;
  // Пока фрагмент звучит, нижнее меню телефона скрыто (lib/ui/stage.svelte.ts).
  $effect(() => {
    stage.live = running || busy;
  });

  function stop() {
    ticket++;
    cancelAnimationFrame(raf);
    try {
      source?.stop();
    } catch {
      /* уже остановлен */
    }
    source = null;
    mic?.stop();
    mic = null;
    running = false;
    busy = false;
  }

  onDestroy(() => {
    stop();
    stage.dark = false;
    stage.live = false;
  });

  async function round(input: Capture) {
    begin = input.ctx.currentTime + (running ? 1 : 3);
    input.begin(begin, to - from);
    const audio = input.ctx.createBufferSource();
    audio.buffer = last.backing;
    audio.connect(input.ctx.destination);
    audio.start(begin, from, to - from);
    source = audio;
    points.length = 0;
  }

  async function play() {
    if (!song || !last.backing) return;
    stop();
    const t = ++ticket;
    busy = true;
    error = "";
    try {
      const input = await Capture.open(() => {}, mics.selected);
      if (t !== ticket) return input.stop();
      mic = input;
      await round(input);
      running = true;
      busy = false;
      const tick = () => {
        if (t !== ticket) return;
        const elapsed = input.ctx.currentTime - begin;
        points.length = 0;
        for (const f of input.frames) points.push({ ...f, t: f.t + from });
        clock = from + elapsed;
        if (elapsed < to - from) raf = requestAnimationFrame(tick);
        else if (loop) {
          void round(input).then(() => (raf = requestAnimationFrame(tick)));
        } else stop();
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      if (t === ticket) {
        error = micError(e);
        stop();
      }
    }
  }

  const lyric = $derived(
    song ? (song.lyrics.filter((l) => l.t <= Math.max(from, clock)).at(-1)?.text ?? "Пой на «ла»").replaceAll(" · ", " ") : "",
  );
</script>

<svelte:head><title>Тренировка — Перепев</title></svelte:head>

{#if !song || !moment || !last.backing}
  <!-- Ярлык и записка с котом — одна группа по центру окна (как страница ошибки): записка
       объясняет, откуда открывается тренировка, а не стоит одной фразой посреди пустой стены. -->
  <section class="empty-page" aria-labelledby="practice-title">
    <TitleStrip text="Тренировка" id="practice-title" fastener="binder" />
    <div class="empty">
      <div class="note-card sheet">
        <h2>Фрагмент недоступен.</h2>
        <p>Тренировка открывается из разбора, пока запись в этой вкладке.</p>
        <h3>Как открыть тренировку</h3>
        <ol>
          <li>Спой песню целиком.</li>
          <li>На экране итога открой «Разбор и ошибки».</li>
          <li>В списке «Что улучшить» нажми «Потренировать» у трудного места.</li>
        </ol>
        <p class="small muted">Тренировка не меняет балл и не сохраняет запись.</p>
        <a class="btn btn-primary" href="/songs">К песням</a>
      </div>
      <span class="empty-cat" aria-hidden="true"><Cat mood="empty" size="100%" /></span>
    </div>
  </section>
{:else}
  <section class="practice">
    <header>
      <a class="back" href="/result" onclick={stop}>← К разбору</a>
      <span class="badge">Тренировка без оценки</span>
    </header>
    <div class="intro">
      <span class="practice-cat" aria-hidden="true"><Cat mood={running ? "singing" : "listening"} size={90} /></span>
      <h1>Фраза {moment.phrase}, <span class="mono">{from.toFixed(1)}–{to.toFixed(1)} с</span></h1>
      <p class="lyric"><mark>{lyric}</mark></p>
    </div>
    <div class="roll sheet">
      <!-- Фраза тренировки бывает короче секунды голоса: своя линия сразу в тональности спетой попытки. -->
      <PianoRoll {song} frames={() => points} time={() => (mic ? from + mic.ctx.currentTime - begin : clock)} span={Math.max(4, to - from + 2)} ownShift={last.result?.registerShift ?? null} />
      {#if running && clock < from}<div class="countdown"><span>{Math.ceil(from - clock)}</span></div>{/if}
    </div>
    <div class="controls">
      <label class="loop"><input type="checkbox" bind:checked={loop} /> По кругу</label>
      <button class="key" aria-pressed={running} disabled={busy} onclick={() => (running ? stop() : void play())}>{busy ? "Подключаем…" : running ? "Остановить" : "Спеть фрагмент"}</button>
      <a class="btn btn-primary" href="/sing/{song.id}" onclick={stop}>Спеть целиком</a>
    </div>
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    <p class="small hint">Тренировка не меняет балл и не сохраняет запись.</p>
  </section>
{/if}

<style>
  .intro { position: relative; padding-right: 112px; min-height: 95px; }
  .practice-cat { position: absolute; top: -10px; right: 0; }
  .empty-page {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(100%, 62rem);
    min-height: calc(100dvh - var(--chrome));
    margin-inline: auto;
    padding: var(--title-top) 0 var(--s-5);
  }
  .empty {
    display: grid;
    grid-template-columns: minmax(0, 32rem) minmax(12rem, 24rem);
    align-items: center;
    justify-content: space-between;
    gap: var(--s-7);
    padding-bottom: var(--s-7);
  }
  .note-card {
    display: grid;
    gap: var(--s-3);
    justify-items: start;
    padding: var(--s-6) var(--s-6) var(--s-5);
    rotate: -0.6deg;
  }
  .note-card h2 {
    font-family: var(--font-hand);
    font-size: 2.4rem;
    letter-spacing: 0;
  }
  .note-card h3 {
    margin-top: var(--s-2);
    font-size: var(--t-m);
  }
  .note-card ol {
    display: grid;
    gap: var(--s-1);
    margin: 0;
    padding-left: 1.3em;
  }
  .note-card .btn {
    margin-top: var(--s-2);
  }
  .empty-cat {
    display: block;
  }
  .practice {
    display: grid;
    grid-template-rows: auto auto 1fr auto auto;
    gap: var(--s-4);
    min-height: calc(100dvh - 120px);
    padding-top: var(--s-3);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .back {
    color: var(--on-room-2);
    text-decoration: none;
  }
  .back:hover {
    color: var(--on-room);
    text-decoration: underline;
  }
  /* Бейдж — штамп, а не плашка. */
  .badge {
    padding: 2px var(--s-3);
    border: 2px solid var(--mustard);
    border-radius: 3px;
    color: var(--mustard);
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    transform: rotate(-3deg);
  }
  h1 {
    font-size: var(--t-2xl);
  }
  h1 .mono {
    font-size: 0.7em;
    color: var(--on-room-2);
  }
  .lyric {
    margin-top: var(--s-2);
    font-size: var(--t-xl);
  }
  mark {
    padding: 0 0.3em;
    background: rgb(242 215 78 / 0.9);
    color: var(--ink);
  }
  .roll {
    position: relative;
    min-height: 260px;
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
  .countdown {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .countdown span {
    display: grid;
    place-items: center;
    width: 8rem;
    height: 8rem;
    border: 5px solid var(--accent);
    border-radius: 50%;
    color: var(--accent);
    font-family: var(--font-hand);
    font-size: 6rem;
    font-weight: 700;
    line-height: 1;
    transform: rotate(-8deg);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: var(--s-4);
  }
  .loop {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    margin-right: auto;
    cursor: pointer;
  }
  .loop input {
    width: 18px;
    height: 18px;
  }
  .hint {
    color: var(--on-room-2);
  }
  /* wide: тренировка помещается в окно — график занимает остаток высоты, клавиши
     «Спеть фрагмент», «Спеть целиком» и «По кругу» не уходят под край на 1366×768. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .practice {
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      height: calc(100svh - var(--chrome));
      min-height: 520px;
    }
    .roll {
      min-height: 0;
      max-height: 460px;
      overflow: hidden;
    }
  }
  /* Сенсорный экран или не wide: цели нажатия не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .back,
    .loop {
      display: inline-flex;
      align-items: center;
      min-height: var(--tap);
    }
  }
  /* Не wide: клавиши переносятся. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .controls {
      flex-wrap: wrap;
    }
  }
  /* compact: кот не теснит заголовок, клавиши во всю ширину. */
  @media (max-width: 599px) {
    .intro {
      padding-right: 72px;
    }
    .practice-cat :global(.cat) {
      width: 64px;
    }
    .controls .key,
    .controls .btn {
      flex: 1 1 100%;
    }
  }
  /* short: график ниже, чтобы клавиши остались в окне. */
  @media (max-height: 520px) and (orientation: landscape) {
    .practice {
      min-height: 0;
    }
    .roll {
      min-height: 190px;
    }
  }
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .empty-page { min-height: 0; padding-inline: 0; }
    .empty { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: var(--s-5); padding: var(--s-5) 0 0; }
    .note-card { width: min(100%, 34rem); rotate: none; }
    .empty-cat { width: 14rem; }
  }
  /* Телефон (PHONE_QUERY): «← К разбору» — стрелка в шапке; штамп остаётся справа. */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .practice header {
      justify-content: flex-end;
    }
    .practice .back {
      display: none;
    }
  }
</style>
