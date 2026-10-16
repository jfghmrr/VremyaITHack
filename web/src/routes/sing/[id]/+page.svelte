<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onDestroy, onMount } from "svelte";
  import { Capture, loadBacking, micError } from "#lib/audio/capture.ts";
  import { loadLayers, startLayers } from "#lib/audio/playback.ts";
  import { chooseMic, initMics, mics, refreshMics } from "#lib/audio/microphones.svelte.ts";
  import { asset, entryFor, loadCatalog, loadSong } from "#lib/catalog.ts";
  import { startPerf, type PerfSession, type PlayMode } from "#lib/precise/uploader.ts";
  import { loadPlayMode, savePlayMode } from "#lib/precise/mode.ts";
  import { giveVoiceConsent, loadVoiceConsent, voiceConsent } from "#lib/precise/consent.svelte.ts";
  import { settle } from "#lib/precise/attempt.svelte.ts";
  import PlayModeSwitch from "#lib/precise/PlayMode.svelte";
  import VoiceConsent from "#lib/precise/VoiceConsent.svelte";
  import { incoming, last, type Ghost } from "#lib/session.svelte.ts";
  import { canonical, score, warmUp } from "#lib/scoring/index.svelte.ts";
  import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";
  import { bestOf, rememberBest } from "#lib/history.svelte.ts";
  import { stage } from "#lib/ui/stage.svelte.ts";
  import PianoRoll from "#lib/ui/PianoRoll.svelte";
  import LiveTrace from "#lib/ui/LiveTrace.svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import LedMeter from "#lib/ui/LedMeter.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Decor from "#lib/brand/Decor.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  import Cat, { type CatSignal } from "#lib/brand/Cat.svelte";
  import Clip from "#lib/brand/Clip.svelte";
  import { tick } from "svelte";
  import { reducedMotion } from "#lib/ui/canvas.ts";
  import { modified, typing } from "#lib/ui/keys.ts";
  import { acquireWakeLock } from "#lib/ui/wakelock.ts";

  import { parseWordTiming, wordProgress, isCurrentWord, type WordTiming } from "#lib/lyrics.ts";

  let wordTiming = $state<WordTiming | null>(null);
  type Phase = "mic" | "sing" | "scoring";

  let song = $state<Song | null>(null);
  let preview = $state<string | null>(null);
  let hasVocals = $state(false);
  let phase = $state<Phase>("mic");
  let ready = $state(false);
  let busy = $state(false);
  let error = $state("");
  let level = $state(0);
  let voiced = $state(false);
  let paused = $state(false);
  let exitOpen = $state(false);
  let clock = $state(-3);
  let useRecord = $state(false);
  let ghost = $state<Ghost | null>(null);
  let ghostResult = $state<ScoreResult | null>(null);
  // Точная оценка: отдельные дорожки песни, режим звука и согласие на запись голоса.
  let stems = $state(false);
  let mode = $state<PlayMode>("headphones");
  // Совет перед пением зависит от режима звука: в «Без наушников» не просим надеть наушники,
  // если звучит только минус.
  const tip = $derived(
    mode === "headphones"
      ? `Надень наушники: без них ${hasVocals ? "голос исполнителя" : "минусовка"} попадёт в запись.${hasVocals ? " Подпевай записи в своей тональности." : ""}`
      : stems
        ? "Без наушников звучит только минус. Сделай его потише, чтобы голос был громче музыки."
        : "Без наушников голос исполнителя из динамика может попасть в запись. Лучше надеть наушники.",
  );
  let declined = $state(false);
  const needsConsent = $derived(!voiceConsent.given && !declined);

  // Неуправляемые реактивностью данные: читаются канвасом в каждом кадре.
  let capture: Capture | null = null;
  let backing: AudioBuffer | null = null;
  let layers: { buffer: AudioBuffer; gain: number }[] = [];
  let playing: { stop(): void } | null = null;
  let perf: PerfSession | null = null;
  let frames: PitchFrame[] = $state.raw([]);
  const trace: { at: number; midi: number | null }[] = [];
  let startAt = 0;
  let raf = 0;
  let ticket = 0;
  let resumeAfterDialog = false;
  let audioPreview: HTMLAudioElement | null = null;
  let releaseWake: (() => void) | null = null;
  let lastUi = 0;
  // Последний кадр для кота: громкость и высота читаются в его requestAnimationFrame.
  const live = { rms: 0, midi: null as number | null };

  const id = $derived(page.params.id ?? "");
  const best = $derived(song ? bestOf(song.id) : null);
  // Номер текущей строки песни (−1 до первой строки) для тетрадного листа со всеми строками.
  const current = $derived.by(() => {
    if (!song || clock < 0) return -1;
    let i = -1;
    song.lyrics.forEach((l, k) => {
      if (l.t <= clock) i = k;
    });
    return i;
  });
  let book: HTMLOListElement | undefined = $state();
  $effect(() => {
    void current;
    void tick().then(() => {
      const line = book?.querySelector<HTMLElement>(".now");
      if (!book || !line) return;
      const dy = line.getBoundingClientRect().top - book.getBoundingClientRect().top;
      book.scrollTo({ top: book.scrollTop + dy - (book.clientHeight - line.clientHeight) / 2, behavior: reducedMotion() ? "auto" : "smooth" });
    });
  });
  const clockText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  // Громкость приподнимает наклейку кота, высота относительно своего диапазона задаёт небольшой наклон.
  const catSignal: CatSignal = () => {
    const level = Math.min(1, live.rms * 6);
    if (live.midi === null) return { level, pitch: null };
    const now = performance.now() / 1000;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of trace) {
      if (p.midi === null || now - p.at > 5) continue;
      lo = Math.min(lo, p.midi);
      hi = Math.max(hi, p.midi);
    }
    return { level, pitch: hi - lo < 2 ? 0.5 : (live.midi - lo) / (hi - lo) };
  };

  onMount(() => {
    const stopMics = initMics();
    mode = loadPlayMode();
    loadVoiceConsent();
    void warmUp().catch(() => {});
    Promise.all([loadSong(id), loadCatalog()])
      .then(async ([s, list]) => {
        song = s;
        const info = entryFor(s.id, list);
        preview = info?.preview ?? null;
        hasVocals = info?.hasVocals === true;
        stems = info?.stems === true;
        if (info?.wordTiming) {
          try {
            const response = await fetch(asset(s.id, info.wordTiming));
            if (response.ok) wordTiming = parseWordTiming(await response.json(), s);
          } catch { /* Line-level lyrics remain available if a sidecar is unavailable. */ }
        }
      })
      .catch((e: Error) => (error = e.message));
    const onHide = () => {
      if (document.hidden && phase === "sing") {
        clean();
        phase = "mic";
        error = "Запись прервана: вкладка ушла в фон. Начни ещё раз, чтобы сохранить точный ритм.";
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      stopMics();
      document.removeEventListener("visibilitychange", onHide);
    };
  });

  onDestroy(() => {
    clean();
    stage.dark = false;
    stage.focus = false;
  });

  // Призрак: вызов из ссылки для этой песни или своя лучшая попытка по выбору.
  $effect(() => {
    if (!song) return;
    const c = incoming.challenge;
    const next: Ghost | null =
      c && c.songId === song.id
        ? { kind: "challenge", name: c.name, curve: c.curve }
        : useRecord && best
          ? { kind: "record", name: "Твой рекорд", curve: best.curve }
          : null;
    ghost = next;
    ghostResult = null;
    if (next) {
      const s = song;
      score(next.curve, s)
        .then((r) => {
          if (ghost === next) ghostResult = r;
        })
        .catch(() => {});
    }
  });

  const ghostFrames = $derived(ghost && ghostResult ? ghost.curve.map((f) => ({ ...f, t: f.t - ghostResult!.lag })) : null);

  function clean() {
    ticket++;
    cancelAnimationFrame(raf);
    playing?.stop();
    playing = null;
    perf?.cancel();
    perf = null;
    capture?.stop();
    capture = null;
    ready = false;
    busy = false;
    paused = false;
    audioPreview?.pause();
    releaseWake?.();
    releaseWake = null;
    stage.dark = false;
    stage.focus = false;
  }

  async function enableMic(deviceId = mics.selected) {
    if (!song) return;
    audioPreview?.pause();
    const t = ++ticket;
    capture?.stop();
    capture = null;
    ready = false;
    busy = true;
    error = "";
    trace.length = 0;
    try {
      const mic = await Capture.open((f) => {
        const now = performance.now();
        trace.push({ at: now / 1000, midi: f.midi });
        live.rms = f.rms ?? 0;
        live.midi = f.midi;
        if (trace.length > 800) trace.splice(0, 200);
        // Текстовые показатели обновляются не чаще 10 раз в секунду.
        if (now - lastUi > 100) {
          lastUi = now;
          level = Math.min(100, (f.rms ?? 0) * 600);
          voiced = f.midi !== null;
        }
      }, deviceId, { echoCancellation: mode === "speaker" });
      if (t !== ticket) {
        mic.stop();
        return;
      }
      capture = mic;
      mic.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (capture !== mic) return;
        clean();
        exitOpen = false;
        phase = "mic";
        error = "Микрофон отключён. Подключи устройство и выбери вход заново.";
      });
      await refreshMics();
      const s = song;
      const loaded = await loadLayers(s.backing, stems, mode, (file) => loadBacking(mic.ctx, asset(s.id, file)));
      if (t === ticket) {
        // Отдельные дорожки не загрузились: звучит исходный микс, подсказки режима — как без них.
        stems = loaded.stems;
        layers = loaded.layers;
        backing = loaded.layers[0].buffer;
        ready = true;
      }
    } catch (e) {
      if (t !== ticket) return;
      await refreshMics();
      capture?.stop();
      capture = null;
      error = micError(e);
    } finally {
      if (t === ticket) busy = false;
    }
  }

  function changeMode(next: PlayMode) {
    mode = next;
    savePlayMode(next);
    // Эхоподавление задаётся при включении микрофона, дорожки — при загрузке.
    if (ready) void enableMic();
  }

  function acceptConsent() {
    giveVoiceConsent();
    void enableMic();
  }

  function declineConsent() {
    declined = true;
    void enableMic();
  }

  function start() {
    const mic = capture;
    if (!mic || !song || !backing) return;
    const s = song;
    error = "";
    paused = false;
    void mic.ctx.resume();
    startAt = mic.ctx.currentTime + 3;
    mic.begin(startAt, s.duration_s);
    frames = mic.frames;
    clock = -3;
    phase = "sing";
    stage.dark = true;
    stage.focus = true;
    // Экран телефона не гаснет, пока идёт пение; clean() отпускает блокировку.
    const wake = acquireWakeLock();
    releaseWake = () => void wake.then((release) => release());
    playing = startLayers(mic.ctx, layers, startAt);
    // Голос уходит на точную оценку только с согласия; отсчёт записи — с нулевой секунды песни.
    const session = voiceConsent.given ? startPerf(s.id, mode) : null;
    perf = session;
    mic.onPcm = session ? (pcm, rate) => session.push(pcm, rate) : null;
    const t = ticket;
    const tick = () => {
      if (t !== ticket) return;
      const now = mic.ctx.currentTime - startAt;
      frames = mic.frames;
      if (Math.floor(now * 30) !== Math.floor(clock * 30)) clock = now;
      if (now < s.duration_s + 0.12) {
        raf = requestAnimationFrame(tick);
        return;
      }
      void finish(mic, s);
    };
    raf = requestAnimationFrame(tick);
  }

  async function finish(mic: Capture, s: Song) {
    const recording = mic.recording();
    const taken = [...mic.frames];
    const buffer = backing;
    // Запись точной оценки переживает уход со страницы: её итог ждёт экран результата.
    const session = perf;
    perf = null;
    clean();
    phase = "scoring";
    try {
      const result = await score(taken, s);
      Object.assign(last, { song: s, frames: taken, result, recording, backing: buffer, ghost });
      const curve = canonical(taken, s.duration_s);
      curve.catch(() => {});
      // В историю и рекорд идёт окончательный балл: точный или браузерный, если слова не проверены.
      settle(s, result, session, (final) => void curve.then((c) => rememberBest(s.id, final.score, c)).catch(() => {}), mode);
      await goto("/result");
    } catch (e) {
      session?.cancel();
      phase = "mic";
      error = (e as Error).message;
    }
  }

  async function setPause(value: boolean) {
    const mic = capture;
    if (!mic) return;
    try {
      // Приостанавливается общий AudioContext: минусовка и захват, временная шкала не сдвигается.
      if (value) await mic.ctx.suspend();
      else await mic.ctx.resume();
      clock = mic.ctx.currentTime - startAt;
      paused = value;
    } catch {
      error = "Не удалось переключить паузу. Начни попытку заново.";
    }
  }

  async function requestExit() {
    if (phase !== "sing") return void goto("/songs");
    resumeAfterDialog = !paused;
    await setPause(true);
    exitOpen = true;
  }

  function onkeydown(e: KeyboardEvent) {
    if (modified(e) || exitOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      void requestExit();
      return;
    }
    if (typing(e)) return;
    if (e.code === "Space" && (phase === "sing" || (phase === "mic" && ready && !busy))) {
      e.preventDefault();
      if (phase === "sing") void setPause(!paused);
      else start();
    }
    if (e.key === "Enter" && phase === "mic" && !busy && !(e.target as HTMLElement)?.closest("button")) {
      e.preventDefault();
      if (ready) start();
      else if (!needsConsent) void enableMic();
    }
  }

  async function listen() {
    if (!song || !preview) return;
    if (audioPreview && !audioPreview.paused) {
      audioPreview.pause();
      return;
    }
    audioPreview = new Audio(asset(song.id, preview));
    try {
      await audioPreview.play();
    } catch {
      error = "Не удалось воспроизвести запись.";
    }
  }

  const status = $derived(
    !ready
      ? "Разреши доступ к микрофону, чтобы проверить сигнал."
      : voiced
        ? "Голос слышен. Можно начинать."
        : level > 6
          ? "Звук есть. Спой протяжную ноту, чтобы появилась линия."
          : "Ничего не слышно. Проверь выбранный вход и спой громче.",
  );
</script>


<svelte:window {onkeydown} />
<svelte:head><title>{song ? `${song.title} — Перепев` : "Перепев"}</title></svelte:head>

{#if !song}
  <div class="loading">
    {#if error}<p class="notice error" role="alert">{error} <a href="/songs">К песням</a></p>{:else}<p class="muted">Загружаем песню…</p>{/if}
  </div>
{:else if phase === "mic"}
  <section class="scene check" aria-labelledby="check-title">
    <header class="check-heading"><TitleStrip text="Проверка микрофона" id="check-title" fastener="binder" /><a class="back" href="/songs">← Другая песня</a></header>
    <div class="mic-layout">
      <div class="mic-left">
        <div class="song-ticket"><span>Сейчас споём</span><h2>{song.title}</h2><span class="mono">{Math.round(song.duration_s)} секунд</span></div>
        <div class="ask sheet"><span class="ask-clip" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={23} /></span><p>Скажи что-нибудь в микрофон, чтобы мы проверили звук.</p></div>
        {#if error}<div class="notice error mic-error" role="alert"><span>{error}</span><button aria-label="Закрыть предупреждение" onclick={() => error = ""}>×</button></div>{/if}
        <PlayModeSwitch {mode} {stems} disabled={busy} onchange={changeMode} />
        {#if needsConsent}<VoiceConsent {busy} onaccept={acceptConsent} ondecline={declineConsent} />{/if}
        <div class="check-cat"><Cat mood={error && !ready ? "unplugged" : "listening"} size="100%" signal={ready ? catSignal : undefined} /></div>
      </div>
      <div class="mic-right">
        <div class="device"><span class="clip"><Clip size={20} rotate={8} /></span><div class="meter-wrap"><LedMeter value={ready ? level : 0} /></div><div class="trace" class:idle={!ready}><LiveTrace points={trace} />{#if !ready}<span>Здесь появится линия голоса</span>{/if}</div></div>
    <div class="checklist sheet">
      <ul>
        <li class:ok={ready}>Микрофон подключён</li>
        <li class:ok={ready && level > 6}>Уровень звука: {!ready ? "ещё не проверен" : level > 6 ? "нормальный" : "слишком тихо"}</li>
        <li class:ok={ready && voiced}>Можно начинать!</li>
        <li class="tip">{tip}</li>
      </ul>
      <p class="status" role="status">{status}</p>
      <label class="field mic">
        <span>Устройство ввода</span>
        <select
          value={mics.selected}
          disabled={busy}
          onchange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            chooseMic(v);
            if (ready) void enableMic(v);
          }}
        >
          <option value="">Системный микрофон по умолчанию</option>
          {#if mics.selected && !mics.devices.some((d) => d.deviceId === mics.selected)}
            <option value={mics.selected}>Сохранённый микрофон не подключён</option>
          {/if}
          {#each mics.devices as d, i (d.deviceId)}
            <option value={d.deviceId}>{d.label || `Микрофон ${i + 1} (название появится после разрешения)`}</option>
          {/each}
        </select>
      </label>
      {#if mics.error}<p class="small" role="status">{mics.error}</p>{/if}
    </div><div class="check-actions">    <div class="extras">
      {#if ghost}
        <p class="ghost-note"><span class="dash" aria-hidden="true"></span>Против призрака: {ghost.name}{ghostResult ? `, ${ghostResult.score.toFixed(1)}` : ""}</p>
      {/if}
      {#if best && !incoming.challenge}
        <label class="record"><input type="checkbox" bind:checked={useRecord} /> Против своего рекорда ({best.score.toFixed(1)})</label>
      {/if}
      {#if preview && !ready}<button class="btn btn-quiet" onclick={listen}>{hasVocals ? "Послушать фрагмент" : "Послушать мелодию"}</button>{/if}
    </div>

      {#if !needsConsent}<button class="btn btn-primary go" disabled={busy} onclick={() => (ready ? start() : void enableMic())}>{busy ? "Подключаем…" : ready ? "Начать пение" : "Включить микрофон"} <span aria-hidden="true">→</span></button>{/if}
      </div></div>
    </div>
    <p class="keys"><span><kbd>Enter</kbd> подтвердить</span><span><kbd>Пробел</kbd> начать</span><span><kbd>Esc</kbd> к песням</span>{#if mode === "headphones"}<span>Надень наушники перед записью.</span>{/if}</p>
  </section>
{:else}
  <!-- Расстановка повторяет мокап «Поем!». -->
  <section class="scene stage" aria-label="Пение">
    <div class="at book sheet" style:--x="3%" style:--y="7%" style:--w="48%" style:--r="-0.6deg">
      <div class="book-title"><TitleStrip text="Поём!" tag="h1" fastener="binder" /></div>
      <p class="song-name">{song.title}</p>
      <ol class="lines" bind:this={book}>
        {#if current < 0}<li class="now"><mark>Вдохни. Выбери удобную высоту.</mark></li>{/if}
        {#each song.lyrics as l, i (i)}
          <li class:now={i === current} class:past={i < current}>
            {#if wordTiming}
              {#each wordTiming.lines[i].words as word}
                <span class="word" class:active-word={i === current && isCurrentWord(word, clock)} class:done-word={clock >= word.end_s} style:--fill={`${wordProgress(word, clock) * 100}%`} aria-current={i === current && isCurrentWord(word, clock) ? 'true' : undefined}>{word.text}</span>{' '}
              {/each}
            {:else if i === current}<mark class="lyric">{l.text.replaceAll(" · ", " ")}</mark>{:else}{l.text.replaceAll(" · ", " ")}{/if}
          </li>
        {/each}
      </ol>
      <span class="rings" aria-hidden="true"></span>
    </div>
    <span class="at deco" style:--x="56%" style:--y="10%" style:--w="27%"><Cat mood={paused ? "idle" : "singing"} size="100%" signal={catSignal}  /></span>
    <span class="at deco" style:--x="53%" style:--y="30%" style:--w="3%"><Decor kind="notes" width="100%" /></span>
    <span class="at deco" style:--x="85%" style:--y="38%" style:--w="3%" style:--r="12deg"><Decor kind="notes" width="100%" /></span>
    <div class="at stage-note" style:--x="83%" style:--y="12%" style:--w="13%" style:--r="3deg"><span class="note-clip" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={20} /></span><span class="rec-label"><i class:paused></i>{paused ? "ПАУЗА" : "НА ЗАПИСИ"}</span><p>Твой голос.<br />Твоя тональность.</p></div>

    <div class="at player" style:--x="55%" style:--y="57%" style:--w="41%">
      <div class="screen">
        <PianoRoll {song} frames={() => frames} time={() => (capture ? capture.ctx.currentTime - startAt : clock)} rival={ghostFrames} rivalShift={ghostResult?.registerShift ?? 0} />
        {#if paused}
          <div class="overlay"><b>Пауза</b><span><kbd>Пробел</kbd> продолжить с той же секунды</span></div>
        {:else if phase === "scoring"}
          <div class="overlay"><b>Считаем интервалы и ритм…</b></div>
        {:else if clock < 0}
          <div class="countdown" aria-live="polite"><span>{Math.ceil(-clock)}</span></div>
        {/if}
      </div>
      <div class="controls">
        <span class="time mono" aria-live="off">{clockText(Math.max(0, clock))} / {clockText(song.duration_s)}</span>
        <span class="small hint"><kbd>Пробел</kbd> пауза <kbd>Esc</kbd> выход</span>
        <button class="round" aria-label={paused ? "Продолжить" : "Пауза"} aria-pressed={paused} disabled={phase !== "sing"} onclick={() => void setPause(!paused)}>
          {#if paused}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>{:else}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>{/if}
        </button>
        <button class="round" aria-label="Выйти" onclick={() => void requestExit()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z" /></svg>
        </button>
      </div>
    </div>
    <div class="at legend" style:--x="55%" style:--y="95%">
      <span class="l-ref">Эталон</span>
      <span class="l-self">Твой голос</span>
      {#if ghost}<span class="l-rival">{ghost.name} (призрак)</span>{/if}
      <span class="l-err">Штрих — ошибка больше полутора тонов</span>
    </div>
  </section>
{/if}

<ConfirmDialog
  open={exitOpen}
  title="Выйти из попытки?"
  text="Запись этой попытки не сохранится. Пока диалог открыт, пение на паузе."
  confirm="Выйти"
  oncancel={() => {
    exitOpen = false;
    if (resumeAfterDialog) void setPause(false);
  }}
  onconfirm={() => {
    exitOpen = false;
    clean();
    void goto("/songs");
  }}
/>

<style>
  .check { display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: 22px; padding: 22px 4% 8px; }
  .check-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .mic-layout { display: grid; grid-template-columns: .9fr 1.1fr; gap: 70px; min-height: 0; align-items: center; }
  .mic-left { display: flex; flex-direction: column; gap: 16px; min-height: 0; height: 100%; padding-top: 10px; }
  .song-ticket { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; border-left: 3px solid #a63830; padding-left: 16px; }
  .song-ticket h2 { font: 700 29px/1.1 var(--font-hand); grid-column: 1/-1; grid-row: 2; }
  .song-ticket > span { font-size: 11px; color: var(--on-room-2); }
  .ask-clip { position: absolute; top: -17px; right: 18px; rotate: 12deg; }
  .check-cat { flex: 1; min-height: 0; align-self: center; width: min(250px,80%); }
  .check-cat :global(.cat), .check-cat :global(img) { height: 100%; }
  .mic-right { display: flex; flex-direction: column; gap: 18px; }
  .check-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .mic-error { font-size: 13px; gap: 10px; }
  .mic-error button { border: 0; background: none; color: var(--ink); min-width: 32px; height: 32px; font-size: 24px; margin-left: auto; align-self: flex-start; }
  .stage-note { padding: 18px 14px 14px; background: var(--paper) var(--tex-paper); color: var(--ink); box-shadow: var(--shadow-sticker); }
  .stage-note p { font: 600 clamp(18px,1.8cqi,25px)/1.05 var(--font-hand); margin-top: 9px; }
  .note-clip { position: absolute; right: 10px; top: -20px; }
  .rec-label { display: flex; align-items: center; gap: 6px; font: 11px/1.1 var(--font-mono); }
  .rec-label i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .rec-label i.paused { background: #857a64; }

  .word { display: inline; border-radius: 2px; }
  .now .word { background: linear-gradient(to right, #eccb62 var(--fill), transparent var(--fill)); }
  .now .active-word { color: #8e191e; text-decoration: underline; text-underline-offset: 4px; }
  .past .done-word { color: var(--ink-2); }

  .loading {
    padding-top: var(--s-8);
  }

  .back {
    font-size: var(--t-s);
    color: var(--on-room-2);
    text-decoration: none;
  }
  .back:hover {
    color: var(--on-room);
    text-decoration: underline;
  }
  .ask {
    padding: var(--s-3) var(--s-4);
    font-weight: 500;
    font-size: clamp(0.95rem, 1.15cqi, 1.3rem);
  }
  .ask p {
    margin: 0;
  }
  .device {
    position: relative;
    flex-shrink: 0;
    grid-template-rows: minmax(0, 1fr);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3);
    height: clamp(100px, 16vh, 190px);
    padding: 10px;
    border: 3px solid #0d0c0d;
    border-radius: 10px;
    background: var(--tex-metal), #2a292b;
    box-shadow: var(--shadow-object);
  }
  .device .clip {
    position: absolute;
    top: -26px;
    left: 30px;
  }
  .meter-wrap {
    min-height: 0;
  }
  .meter-wrap :global(.led) {
    min-height: 0;
    height: 100%;
    box-shadow: inset 0 2px 6px rgb(0 0 0 / 0.8);
  }
  .trace {
    position: relative;
    border-radius: 6px;
    background: #141314;
    box-shadow: inset 0 2px 6px rgb(0 0 0 / 0.8);
    --line: #2c2a2d;
    --accent: var(--accent-bright);
  }
  .trace span {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--s-2);
    color: var(--on-room-3);
    font-size: var(--t-xs);
    text-align: center;
  }
  .checklist {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-5);
  }
  .checklist ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .mic {
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: var(--s-3);
    font-size: var(--t-xs);
  }
  .mic select {
    min-height: 32px;
    font-size: var(--t-xs);
  }
  .extras {
    display: grid;
    gap: var(--s-1);
    justify-items: start;
  }
  .checklist li {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    font-size: var(--t-s);
  }
  .checklist li::before {
    content: "";
    display: grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border: 2px solid var(--ink);
    border-radius: 3px;
    font-family: system-ui, sans-serif;
    font-size: 15px;
    font-weight: 800;
  }
  .checklist li.ok::before {
    content: "✓";
    border-color: #3f8a3a;
    background: #3f8a3a;
    color: #fff;
  }
  .checklist li.tip {
    color: var(--ink-2);
    font-size: var(--t-xs);
  }
  .checklist li.tip::before {
    content: "!";
    border-color: var(--accent);
    color: var(--accent);
    font-size: 13px;
  }
  .status {
    font-size: var(--t-s);
    font-weight: 600;
  }
  .record {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--t-s);
    cursor: pointer;
  }
  .record input {
    width: 18px;
    height: 18px;
  }
  .ghost-note {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--t-s);
    color: var(--rival-bright);
    font-weight: 600;
  }
  .dash {
    width: 28px;
    height: 2px;
    background: repeating-linear-gradient(90deg, var(--rival-bright) 0 6px, transparent 6px 10px);
  }
  .go {
    min-height: 54px;
    min-width: 240px;
    font-size: clamp(1.4rem, 1.8cqi, 2.2rem);
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-4);
    margin: 0;
    font-size: 0.72rem;
    color: var(--on-room-2);
  }

  /* «Поем!»: тетрадь со строками песни слева, поющий кот и плеер справа. */
  .stage {
    height: calc(100dvh - var(--s-4));
  }
  .book {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    height: 86%;
    padding: var(--s-7) var(--s-7) var(--s-5) var(--s-7);
    background-image:
      linear-gradient(90deg, transparent 2.4rem, var(--margin) 2.4rem, var(--margin) calc(2.4rem + 1px), transparent calc(2.4rem + 1px)),
      var(--tex-paper);
    transform: rotate(-0.6deg);
  }
  .book-title {
    position: absolute;
    left: -10px;
    top: -26px;
  }
  /* Кольца пружины по правому краю, как в тетради на мокапе. */
  .rings {
    position: absolute;
    top: 18px;
    bottom: 18px;
    right: -9px;
    width: 22px;
    background:
      radial-gradient(circle 4px at 6px 50%, var(--room) 96%, transparent) 0 0 / 22px 30px repeat-y,
      linear-gradient(90deg, transparent 8px, #9e9d98 8px, #e2e1db 13px, #8e8d88 18px, transparent 18px) 0 9px / 22px 30px repeat-y;
    pointer-events: none;
  }
  .song-name {
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    color: var(--ink-3);
    margin-bottom: var(--s-2);
  }
  .lines {
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
    scrollbar-width: none;
    background: repeating-linear-gradient(180deg, transparent 0 calc(2.75rem - 1px), var(--rule) calc(2.75rem - 1px) 2.75rem);
  }
  .lines li {
    min-height: 2.75rem;
    padding: 0 var(--s-2);
    line-height: 2.75rem;
    font-size: var(--t-xl);
    color: var(--ink);
  }
  .lines li.past {
    color: var(--ink-3);
  }
  .lines li.now {
    font-weight: 700;
    font-size: clamp(1.4rem, 2cqi, 1.75rem);
  }
  /* Маркер под текущей строкой: текст остаётся чёрным, контраст не падает. */
  mark {
    padding: 0.05em 0.25em;
    background: linear-gradient(100deg, transparent 0.2em, rgb(242 215 78 / 0.9) 0.35em, rgb(242 215 78 / 0.75) calc(100% - 0.3em), transparent);
    color: var(--ink);
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .player {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: var(--s-3);
    height: 36%;
    padding: 12px;
    border: 3px solid #0d0c0d;
    border-radius: 14px;
    background:
      linear-gradient(rgb(255 255 255 / 0.06), transparent 30%),
      var(--tex-metal),
      #2a292b;
    box-shadow: var(--shadow-object);
  }
  .screen {
    position: relative;
    min-height: 120px;
    border-radius: 8px;
    background: #121112;
    box-shadow: inset 0 3px 10px rgb(0 0 0 / 0.9);
    overflow: hidden;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .time {
    padding: 4px 10px;
    border-radius: 3px;
    background: #0f0e0f;
    color: #e8c46a;
    box-shadow: inset 0 2px 4px rgb(0 0 0 / 0.8);
  }
  .hint {
    margin-right: auto;
    color: var(--on-room-2);
  }
  /* Круглые клавиши плеера: нажатая утоплена. */
  .round {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border: 2px solid #0d0c0d;
    border-radius: 50%;
    background: linear-gradient(#e2e1db, #a9a8a2);
    color: #1b1a19;
    cursor: pointer;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.7),
      0 4px 0 #4a4845,
      0 6px 10px rgb(0 0 0 / 0.5);
    transition:
      transform var(--d-fast) var(--ease),
      box-shadow var(--d-fast) var(--ease);
  }
  .round svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
  }
  .round:active:not(:disabled),
  .round[aria-pressed="true"] {
    transform: translateY(4px);
    box-shadow:
      inset 0 2px 4px rgb(0 0 0 / 0.35),
      0 0 0 #4a4845;
  }
  .round:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .countdown,
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--s-2);
    pointer-events: none;
    text-align: center;
  }
  .countdown span {
    display: grid;
    place-items: center;
    width: 8rem;
    height: 8rem;
    border: 5px solid var(--accent-bright);
    border-radius: 50%;
    color: var(--paper);
    font-family: var(--font-hand);
    font-size: 6rem;
    font-weight: 700;
    line-height: 1;
    transform: rotate(-8deg);
  }
  .overlay {
    background: rgb(18 17 18 / 0.82);
    color: var(--on-room);
  }
  .overlay b {
    font-family: var(--font-hand);
    font-size: 2.6rem;
    line-height: 1;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-5);
    font-size: var(--t-xs);
    color: var(--on-room-2);
  }
  .legend span::before {
    content: "";
    display: inline-block;
    width: 22px;
    height: 4px;
    margin-right: var(--s-2);
    vertical-align: middle;
    border-radius: 2px;
  }
  .l-ref::before {
    background: var(--stage-reference);
    height: 8px !important;
  }
  .l-self::before {
    background: var(--stage-accent);
  }
  .l-rival::before {
    background: repeating-linear-gradient(90deg, var(--stage-rival) 0 6px, transparent 6px 10px);
  }
  .l-err::before {
    background: repeating-linear-gradient(90deg, var(--stage-accent) 0 3px, transparent 3px 7px);
  }
  /* Сенсорный экран или не wide: цели нажатия на проверке микрофона не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .back { display: inline-flex; align-items: center; min-height: var(--tap); }
    .mic select { min-height: var(--tap); height: var(--tap); }
    .mic-error button { min-width: var(--tap); height: var(--tap); }
    .record { min-height: var(--tap); }
  }
  /* Не wide: проверка микрофона идёт потоком, «Начать пение» сразу под индикатором. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .check { display: grid; height: auto; gap: var(--s-4); padding: var(--s-4) 0 0; }
    .check-heading { align-items: flex-start; flex-wrap: wrap; }
    .mic-layout { grid-template-columns: minmax(0, 1fr); gap: var(--s-5); }
    .mic-left { height: auto; padding-top: 0; }
    .check-cat { display: none; }
    .checklist { rotate: 0deg; }
    .checklist li { white-space: normal; }
    .checklist .mic { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; }
    .mic select { width: 100%; min-width: 0; max-width: 100%; }
    /* Кнопка сразу под индикатором: видна в первом экране телефона, список проверок ниже. */
    .check-actions { order: 1; flex-wrap: wrap; }
    .checklist { order: 2; }
    .go { flex: 1 1 240px; min-width: 0; }
  }
  /* compact: проверка микрофона плотнее — с переключателем «В наушниках / Без наушников»
     «Начать пение» остаётся в первом экране телефона (360×740, 375×667). */
  @media (max-width: 599px) {
    .check { gap: var(--s-2); }
    .check-heading { row-gap: 0; }
    .mic-layout { gap: var(--s-3); }
    .mic-left { gap: var(--s-3); }
    .ask { padding: var(--s-2) var(--s-3); }
    .device { height: clamp(88px, 13vh, 112px); }
  }
  /* Телефон: подсказки клавиатуры не нужны; на сцене строки песни мельче, чтобы меньше переносились. */
  @media (max-width: 599px), (max-height: 520px) and (orientation: landscape) {
    .keys { display: none; }
    .lines { background: repeating-linear-gradient(180deg, transparent 0 calc(2.4rem - 1px), var(--rule) calc(2.4rem - 1px) 2.4rem); }
    .lines li { min-height: 2.4rem; line-height: 2.4rem; font-size: 1.125rem; }
    .lines li.now { font-size: 1.25rem; }
  }
  /* short: две колонки — песня и подсказка слева, индикатор и проверки справа. */
  @media (max-height: 520px) and (orientation: landscape) {
    .mic-layout { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); align-items: start; gap: var(--s-5); }
    .device { height: 96px; }
  }

  /* Не wide: сцена пения во весь экран, без прокрутки страницы. Портрет: строки песни,
     легенда и график, клавиши плеера внизу над полоской «домой». Кот и декор скрыты. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .stage {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto auto;
      align-items: stretch;
      gap: var(--s-3);
      height: calc(100dvh - var(--safe-top));
      margin-bottom: calc(-1 * var(--s-4));
      padding: var(--s-6) 0 0;
    }
    .stage .at { max-width: none; }
    .stage .book { grid-row: 1; height: auto; min-height: 0; padding: var(--s-6) var(--s-5) var(--s-3) var(--s-7); transform: none; }
    .book-title { left: 4px; top: -24px; }
    .stage .book-title :global(.strip) { min-width: 0; padding: 10px 26px 14px; }
    .stage .book-title :global(.text) { font-size: 1.6rem; }
    .stage .legend { grid-row: 2; gap: 2px var(--s-4); font-size: 0.72rem; }
    .stage .player { grid-row: 3; height: auto; min-height: 0; gap: var(--s-2); padding: 8px 8px max(8px, var(--safe-bottom)); border-radius: 14px 14px 0 0; }
    .screen { min-height: 0; height: clamp(150px, 30dvh, 360px); }
    .stage-note, .hint { display: none; }
    .stage .time { margin-right: auto; }
  }
  /* Ландшафт телефона (short) и планшета: строки песни слева (55 %), справа легенда,
     график и клавиши. */
  @media (max-height: 520px) and (orientation: landscape), (min-width: 600px) and (max-width: 1099px) and (min-height: 521px) and (orientation: landscape) {
    .stage { grid-template-columns: 55% minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); column-gap: var(--s-4); }
    .stage .book { grid-column: 1; grid-row: 1 / -1; }
    .stage .legend { grid-column: 2; grid-row: 1; align-self: end; }
    .stage .player { grid-column: 2; grid-row: 2; }
    .screen { height: auto; }
  }
  /* medium в портрете (планшет): график выше, строки крупнее, тетрадь не пустует. */
  @media (min-width: 600px) and (max-width: 1099px) and (min-height: 521px) and (orientation: portrait) {
    .screen { height: clamp(150px, 40dvh, 520px); }
    .lines { background: repeating-linear-gradient(180deg, transparent 0 calc(3.25rem - 1px), var(--rule) calc(3.25rem - 1px) 3.25rem); }
    .lines li { min-height: 3.25rem; line-height: 3.25rem; font-size: 1.6rem; }
    .lines li.now { font-size: 1.9rem; }
  }
  @media (max-height: 520px) and (orientation: landscape) {
    .stage { gap: var(--s-2) var(--s-4); padding-top: var(--s-5); }
    /* Отступ сверху под ярлык «Поём!»: название песни не прячется под ним. */
    .stage .book { padding: 34px var(--s-4) var(--s-2) var(--s-6); }
    .book-title { top: -14px; }
    .stage .book-title :global(.text) { font-size: 1.35rem; }
    .stage .book-title :global(.strip) { padding: 8px 22px 12px; }
    .stage .book-title :global(.star) { display: none; }
  }
</style>
