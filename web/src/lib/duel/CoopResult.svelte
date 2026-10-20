<script module lang="ts">
  import type { PitchFrame, ScoreResult } from "#lib/scoring/types.ts";

  /** Линии этого устройства: своя запись и точки партнёра из матча, с разбором ядра. */
  export interface CoopFinals {
    myCurve: PitchFrame[];
    mine: ScoreResult;
    theirCurve: PitchFrame[] | null;
    theirs: ScoreResult | null;
  }
</script>

<script lang="ts">
  // Итог «Вместе»: общий балл, балл партии каждого и самое трудное место каждого, без слов
  // о победе и поражении. «Прослушать всю песню» озвучивает обе линии высоты синтезированным
  // голосом (curve-voice.ts) под минус: каждый — только в свои ходы, одним исполнением.
  // С согласием обоих по умолчанию звучат настоящие голоса (записи своих ходов), как только
  // обе записи здесь; почему они не звучат, итог говорит прямо (voiceNotes).
  import { onDestroy, onMount, untrack } from "svelte";
  import type { MatchView, PartResult, PlayerView } from "#lib/api/types.ts";
  import type { Room } from "#lib/live/client.svelte.ts";
  import { asset, entryFor, loadCatalog } from "#lib/catalog.ts";
  import { CurveVoices } from "#lib/audio/curve-voice.ts";
  import { lineAt } from "#lib/lyrics.ts";
  import type { Song } from "#lib/scoring/types.ts";
  import { REASON_LABEL } from "./analysis.ts";
  import { coopLines, type CoopPart } from "./coop.ts";
  import { fetchVoice, listenNote, recallLags, sharingOf, voiceNotes, VoiceMix, type Arrival, type Upload, type VoiceFetch } from "./coop-voice.ts";
  import { backingLoader, CoopListening, type Backing } from "./coop-listen.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Polaroid from "#lib/brand/Polaroid.svelte";

  let {
    view,
    me,
    partner,
    song,
    finals,
    voice,
    invite,
    rematching,
    error,
    reason,
    onrematch,
    onexit,
    onwithdraw,
    onresend,
  }: {
    view: MatchView;
    me: PlayerView | null;
    partner: PlayerView | null;
    song: Song;
    finals: CoopFinals | null;
    /**
     * Настоящие голоса на этом устройстве: пело ли оно эту песню, своя запись (16 кГц, свои ходы),
     * её отправка и можно ли отправить ещё раз (срок отправки открыт).
     */
    voice: { recorded: boolean; mine: Float32Array | null; upload: Upload; canResend: boolean };
    invite: Room | null;
    rematching: boolean;
    error: string;
    reason: string;
    onrematch: () => void;
    onexit: () => void;
    /** Снять согласие после песни: сервер удаляет голоса; true — сервер подтвердил. */
    onwithdraw: () => Promise<boolean>;
    /** «Отправить ещё раз»: своя запись не сохранилась, срок отправки ещё открыт. */
    onresend: () => void;
  } = $props();

  const team = $derived(view.result?.team ?? null);
  const myPart = $derived<PartResult | null>(team?.parts.find((p) => p.user_id === me?.user_id) ?? null);
  const theirPart = $derived<PartResult | null>(team?.parts.find((p) => p.user_id !== me?.user_id) ?? null);
  const partnerName = $derived(partner?.name ?? "Друг");
  const shiftOf = (userId: string | undefined) => view.result?.players.find((p) => p.user_id === userId)?.shift ?? null;

  const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1).replace(".", ","));
  const secs = (t: number) => t.toFixed(1).replace(".", ",");
  const lineText = (t: number) => {
    const i = lineAt(song.lyrics, t + 0.3);
    return i >= 0 ? song.lyrics[i].text.replaceAll(" · ", " ") : "";
  };

  // Минус песни (без вокала) начинает готовиться сразу. Прослушивание его ждёт (CoopListening):
  // нажатие сразу после песни раньше играло голоса без минуса, пока он ещё декодировался.
  async function loadInstrumental(): Promise<Backing<AudioBuffer>> {
    try {
      const list = await loadCatalog();
      if (!entryFor(song.id, list)?.stems) return { buffer: null, missing: false };
      const r = await fetch(asset(song.id, "instrumental.mp3"));
      if (!r.ok) return { buffer: null, missing: true };
      return { buffer: await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await r.arrayBuffer()), missing: false };
    } catch {
      return { buffer: null, missing: true };
    }
  }
  // Ждём не дольше 15 с; не загрузился или повис — следующее нажатие загружает заново.
  const instrumental = backingLoader(loadInstrumental, 15_000);
  onMount(() => instrumental.prefetch());

  // Записи для настоящих голосов (если согласились оба): партнёра — с сервера, как только он
  // её отправит; своя — с этого устройства, а если страницу открыли заново — тоже с сервера.
  let withdrawn = $state(false);
  // Пояснение, кнопки и загрузка — по согласию обоих от сервера, а не по выбору на этой странице.
  const sharing = $derived(sharingOf(withdrawn, view.players));
  let theirVoice = $state<Float32Array | null>(null);
  let theirs = $state<Arrival | "ready" | "idle">("idle");
  let ownServer = $state<Float32Array | null>(null);
  let ownState = $state<Arrival | "idle">("idle");
  const mine = $derived(voice.mine ?? ownServer);
  const realReady = $derived(sharing === "shared" && !!mine && !!theirVoice);
  // Задержки записей — из разбора линий; после перезагрузки итога — из этой вкладки.
  const stored = $derived(recallLags(view.match_id));
  const lagMine = $derived(finals?.mine.lag ?? stored?.mine ?? 0);
  const lagTheirs = $derived(finals?.theirs?.lag ?? stored?.theirs ?? 0);
  /** Что звучит: настоящие голоса (когда обе записи здесь) или синтезированный голос по линиям. */
  let source = $state<"real" | "synth">("synth");
  /** Источник выбран игроком сам — тогда настоящие голоса не включаются за него. */
  let chosen = $state(false);
  // Обычная переменная, а не состояние: эффект не должен перезапускаться (и обрывать загрузку)
  // от собственной записи состояния.
  let fetching: AbortController | null = null;
  const arrival = (r: VoiceFetch): Arrival => (r.kind === "ok" ? "here" : r.kind === "aborted" ? "timeout" : r.kind);
  function load() {
    fetching?.abort();
    const abort = (fetching = new AbortController());
    if (partner && !theirVoice) {
      theirs = "waiting";
      void fetchVoice(view.match_id, partner.slot, abort.signal).then((r) => {
        if (abort.signal.aborted) return;
        if (r.kind === "ok") theirVoice = r.samples;
        theirs = r.kind === "ok" ? "ready" : arrival(r);
      });
    }
    // Своя запись с сервера — только если это устройство песню не записывало (итог открыли заново).
    if (!voice.recorded && me && !ownServer) {
      ownState = "waiting";
      void fetchVoice(view.match_id, me.slot, abort.signal).then((r) => {
        if (abort.signal.aborted) return;
        if (r.kind === "ok") ownServer = r.samples;
        ownState = arrival(r);
      });
    }
  }
  $effect(() => {
    if (sharing !== "shared" || !partner || fetching) return;
    untrack(load);
  });
  onDestroy(() => fetching?.abort());
  // Обе записи здесь — по умолчанию выбраны настоящие голоса. Уже звучащий синтезированный голос
  // сменяется ими с того же места (CoopListening: и когда запись пришла, пока звук запускался).
  $effect(() => {
    if (realReady && !chosen) source = "real";
  });
  $effect(() => {
    const o = { realReady, chosen };
    untrack(() => listener.set(o));
  });
  const noteOf = (kind: "real" | "synth" | "unavailable") => listenNote(kind, { sharing, partner: partnerName, partnerLine: !!finals?.theirCurve });
  const notes = $derived(
    voiceNotes(
      {
        sharing,
        me: !!me?.share_voice,
        partner: !!partner?.share_voice,
        upload: voice.upload,
        own: voice.mine || voice.recorded ? "here" : ownState === "idle" ? "waiting" : ownState,
        theirs: theirs === "idle" ? "waiting" : theirs,
        synth: !!finals,
      },
      partnerName,
    ),
  );
  const loading = $derived(sharing === "shared" && (theirs === "waiting" || ownState === "waiting"));
  const timedOut = $derived(theirs === "timeout" || ownState === "timeout");
  let withdrawing = $state(false);
  let withdrawError = $state("");
  // «Записи удалены» — только после подтверждения сервера; при отказе кнопка остаётся.
  async function withdraw() {
    stop();
    withdrawing = true;
    withdrawError = "";
    const ok = await onwithdraw();
    withdrawing = false;
    if (!ok) {
      withdrawError = "Не удалось снять согласие: сервер не подтвердил. Проверь связь и нажми ещё раз.";
      return;
    }
    fetching?.abort();
    withdrawn = true;
    theirVoice = null;
    ownServer = null;
    source = "synth";
  }
  function choose(s: "real" | "synth") {
    chosen = true;
    stop();
    source = s;
  }

  /** Что звучит прямо сейчас, окно прослушивания и ошибка запуска — зеркало CoopListening. */
  let playing = $state<"real" | "synth" | null>(null);
  let listening = $state<{ from: number; to: number; moment: number | null } | null>(null);
  let listenAt = $state(0);
  let listenError = $state("");
  /** Нажали «Прослушать», минус ещё готовится; минус не загрузился. */
  let preparing = $state(false);
  let backingMissing = $state(false);
  let following = false;

  const pan = (slot: number | undefined) => ((slot ?? 0) === 0 ? -0.25 : 0.25);
  // Один контекст звука на нажатие: создаётся в обработчике, на нём же синтез сменяется
  // настоящими голосами без нового нажатия (новый контекст без жеста может остаться приостановленным).
  const listener = new CoopListening<AudioContext, AudioBuffer>({
    // Запуск — в обработчике нажатия: звук стартует позже, когда готов минус.
    context: () => {
      const ctx = new AudioContext();
      // «Стоп» или уход, пока контекст ещё запускается, закрывают его: отказ resume() ожидаем.
      void ctx.resume().catch(() => {});
      return ctx;
    },
    close: (ctx) => {
      if (ctx.state !== "closed") void ctx.close();
    },
    backing: () => instrumental.get(),
    synth: (ctx, from, to, onEnd, track) => {
      const f = finals!;
      const parts: CoopPart[] = [{ slot: me?.slot ?? 0, frames: f.myCurve, lag: f.mine.lag, shift: shiftOf(me?.user_id) ?? f.mine.shift }];
      if (f.theirCurve && f.theirs) {
        parts.push({ slot: partner?.slot ?? 1, frames: f.theirCurve, lag: f.theirs.lag, shift: shiftOf(partner?.user_id) ?? f.theirs.shift });
      }
      return CurveVoices.play({ lines: coopLines(view.turns ?? [], parts), backing: track, from, to, onEnd, ctx });
    },
    // Минус и обе записи по времени песни, задержка каждого вычтена.
    real: (ctx, from, to, onEnd, track, at) =>
      VoiceMix.play({
        voices: [
          { samples: mine!, lag: lagMine, pan: pan(me?.slot) },
          { samples: theirVoice!, lag: lagTheirs, pan: pan(partner?.slot) },
        ],
        backing: track,
        from,
        to,
        onEnd,
        ctx,
        at,
      }),
    changed: () => {
      playing = listener.playing;
      listening = listener.window;
      listenError = listener.error;
      preparing = listener.preparing;
      backingMissing = listener.backingMissing;
      if (!playing) listenAt = 0;
      else if (!following) follow();
    },
  });

  function follow() {
    following = true;
    const tick = () => {
      if (!listener.playing) {
        following = false;
        return;
      }
      listenAt = listener.position;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stop() {
    listener.stop();
  }
  onDestroy(stop);

  /** Обе партии одним исполнением: вся песня или окно трудного места `moment` (его начало). */
  function listen(moment: { start_s: number; end_s: number } | null = null) {
    const real = source === "real" && realReady;
    if (!finals && !real) return;
    const from = moment ? Math.max(0, moment.start_s - 0.3) : 0;
    const to = moment ? Math.min(song.duration_s, moment.end_s + 0.3) : song.duration_s;
    void listener.listen(real ? "real" : "synth", from, to, moment?.start_s ?? null);
  }

  const sides = $derived([
    { cls: "self", label: "Ты", name: me?.name ?? "", part: myPart, tint: "red" as const },
    { cls: "rival", label: "Партнёр", name: partnerName, part: theirPart, tint: "blue" as const },
  ]);
</script>

<section class="coop-final" aria-label="Итог «Вместе»">
  <header class="head">
    <TitleStrip text="Вместе" tag="div" />
    <h2 class="kind">Спели «{view.song.title}» по очереди · без рейтинга{view.result?.technical ? " · не до конца" : ""}</h2>
  </header>

  <div class="team sheet">
    <h1 class="team-title">Общий балл</h1>
    <b class="team-score mono" data-testid="team-score">{fmt(team?.score)}</b>
    <p class="small">
      {#if team?.score != null}
        Среднее двух партий с учётом их длины: у кого больше мелодии, у того больше вес.
      {:else}
        {reason} Общий балл считается, только когда обе партии спеты до конца.
      {/if}
    </p>
  </div>

  {#each sides as side (side.cls)}
    <article class="part card {side.cls}">
      <span class="tape" aria-hidden="true"></span>
      <span class="who">{side.label}</span>
      <h2 class="name">{side.name}</h2>
      <span class="pic"><Polaroid><Cat mood="happy" tint={side.tint} size="88%" /></Polaroid></span>
      <span class="small part-label">Партия · {side.part?.turns ?? 0} {side.part?.turns === 1 ? "ход" : (side.part?.turns ?? 0) < 5 ? "хода" : "ходов"}</span>
      <b class="score mono" data-testid="part-score">{fmt(side.part?.score)}</b>
      {#if side.part?.hardest}
        {@const h = side.part.hardest}
        <div class="hard">
          <span class="small"><b>Труднее всего:</b> {secs(h.start_s)}–{secs(h.end_s)} с · {REASON_LABEL[h.reason]}</span>
          {#if lineText(h.start_s)}<span class="line small">«{lineText(h.start_s)}»</span>{/if}
          {#if finals || realReady}<button class="btn btn-quiet" aria-pressed={listening?.moment === h.start_s} onclick={() => listen(h)}>{preparing && listening?.moment === h.start_s ? "Готовим минус…" : "▶ Послушать это место"}</button>{/if}
        </div>
      {:else if side.part?.score != null}
        <span class="small hard">Трудных мест не нашлось.</span>
      {/if}
    </article>
  {/each}

  <div class="listen sheet">
    {#if sharing === "shared"}
      <div class="segmented source" role="group" aria-label="Что звучит">
        <button type="button" aria-pressed={source === "real"} disabled={!realReady} onclick={() => choose("real")}>Настоящие голоса</button>
        <button type="button" aria-pressed={source === "synth"} disabled={!finals} onclick={() => choose("synth")}>Синтезированный голос</button>
      </div>
    {/if}
    {#each notes as note (note)}<p class="small honest voice-note" role="status">{note}</p>{/each}
    <!-- Повторить можно, только пока голосом делятся оба: после снятия согласия кнопок нет. -->
    {#if sharing === "shared" && (voice.canResend || timedOut)}
      <div class="listen-row">
        {#if voice.canResend}<button type="button" class="btn" onclick={onresend}>Отправить ещё раз</button>{/if}
        {#if timedOut}<button type="button" class="btn btn-quiet" onclick={load}>Проверить ещё раз</button>{/if}
      </div>
    {/if}
    {#if sharing === "shared"}
      <button type="button" class="btn btn-quiet withdraw" disabled={withdrawing} onclick={withdraw}>Не делиться голосом и удалить записи</button>
      <p class="small honest">Снять согласие можно в любой момент: копия на сервере удалится сразу, и партнёр больше не сможет её получить. Если его страница уже загрузила твою запись, она останется в ней, пока партнёр не закроет страницу; на сервере она не хранится и никуда не передаётся.</p>
      {#if withdrawError}<p class="small error" role="alert">{withdrawError}</p>{/if}
    {/if}
    {#if finals || realReady}
      <div class="listen-row">
        <button class="btn btn-primary" aria-pressed={!!listening && listening.moment == null} onclick={() => listen()}>{preparing && listening?.moment == null ? "Готовим минус…" : "▶ Прослушать всю песню"}</button>
        <button class="btn btn-quiet" disabled={!listening} onclick={stop}>■ Стоп</button>
        {#if listening}
          <span class="mono small" aria-live="off">{secs(listenAt)} / {secs(listening.to)} с</span>
          <span class="progress" aria-hidden="true"><i style:width="{((listenAt - listening.from) / Math.max(0.1, listening.to - listening.from)) * 100}%"></i></span>
        {/if}
      </div>
      <!-- Пояснение — о том, что звучит сейчас, а без звука — о том, что зазвучит по нажатию. -->
      <p class="small honest" data-testid="listen-note">{noteOf(playing ?? (source === "real" && realReady ? "real" : "synth"))}</p>
      {#if backingMissing}<p class="small honest" role="status">Минус песни не загрузился, поэтому голоса звучат без него. Проверь связь и нажми «Прослушать» ещё раз.</p>{/if}
      {#if listenError}<p class="small error" role="alert">{listenError}</p>{/if}
    {:else if !loading}
      <p class="small honest" data-testid="listen-note">{noteOf("unavailable")}</p>
    {/if}
  </div>

  <div class="actions">
    {#if invite}
      <p class="invite-note" role="status">{partnerName} зовёт спеть ещё раз вместе: та же песня, по очереди.</p>
      <a class="btn btn-primary" href="/duels/room/{invite.code}">Спеть ещё раз</a>
    {:else}
      <button class="btn btn-primary" disabled={rematching} onclick={onrematch} title="Та же песня с тем же другом, снова по очереди">{rematching ? "Открываем комнату…" : "Ещё раз вместе"}</button>
    {/if}
    <a class="btn" href="/duels" onclick={onexit}>К дуэлям</a>
    {#if error}<p class="invite-note error" role="alert">{error}</p>{/if}
  </div>
</section>

<style>
  .coop-final {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) minmax(0, 1fr);
    grid-template-areas:
      "head head head"
      "self team rival"
      "self listen rival"
      "actions actions actions";
    gap: var(--s-4) var(--s-6);
    align-items: start;
    padding-top: var(--s-3);
  }
  .head {
    grid-area: head;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3) var(--s-5);
  }
  .kind {
    margin: 0;
    padding: 3px 12px 5px;
    background: var(--kraft) var(--tex-paper);
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: clamp(1.2rem, 1.5vw, 1.6rem);
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.15;
    rotate: -1deg;
    box-shadow: var(--shadow-sticker), 0 3px 8px rgb(0 0 0 / 0.45);
  }
  .team {
    grid-area: team;
    display: grid;
    justify-items: center;
    gap: var(--s-1);
    padding: var(--s-4) var(--s-5);
    text-align: center;
  }
  .team-title {
    margin: 0;
    font-family: var(--font-hand);
    font-size: 2rem;
    letter-spacing: 0;
    line-height: 1;
  }
  .team-score {
    font-family: var(--font-poster);
    font-size: clamp(3.4rem, 6vw, 5.6rem);
    font-weight: 700;
    line-height: 1;
    color: var(--ink);
  }
  .team .small {
    max-width: 34ch;
    color: var(--ink-2);
  }
  .part {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 0.3em;
    padding: 1.1em 1.2em 1em;
    background: #e8dcc2 var(--tex-paper);
    color: var(--ink);
    text-align: center;
    box-shadow: var(--shadow-sheet);
    --muted: var(--ink-2);
  }
  .part.self {
    grid-area: self;
    rotate: -1.5deg;
    box-shadow:
      inset 0 5px 0 var(--accent),
      var(--shadow-sheet);
  }
  .part.rival {
    grid-area: rival;
    rotate: 1.5deg;
    box-shadow:
      inset 0 0 0 2px var(--rival),
      var(--shadow-sheet);
  }
  .part .tape {
    left: 38%;
    top: -12px;
  }
  .who {
    font-family: var(--font-hand);
    font-size: 1.4rem;
    font-weight: 700;
    line-height: 1;
  }
  .name {
    margin: 0;
    font-family: var(--font-hand);
    font-size: 1.9rem;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1;
    overflow-wrap: anywhere;
  }
  .pic {
    width: min(150px, 60%);
  }
  .part-label {
    color: var(--ink-2);
  }
  .score {
    font-family: var(--font-poster);
    font-size: clamp(2.4rem, 3.4vw, 3.6rem);
    font-weight: 700;
    line-height: 1;
  }
  .self .score {
    color: var(--accent);
  }
  .rival .score {
    color: var(--rival);
  }
  .hard {
    display: grid;
    justify-items: center;
    gap: 2px;
  }
  .hard .line {
    font-weight: 600;
  }
  .listen {
    grid-area: listen;
    display: grid;
    /* Колонка не шире листа: на телефоне переключатель источника не раздвигает страницу. */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
  }
  .source {
    justify-self: start;
  }
  .source > button {
    white-space: normal;
  }
  .listen-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-3);
  }
  .listen [aria-pressed="true"] {
    box-shadow: inset 0 0 0 2px var(--ink);
  }
  .progress {
    flex: 1 1 100%;
    height: 6px;
    background: rgb(0 0 0 / 0.1);
  }
  .progress i {
    display: block;
    height: 100%;
    background: var(--ink);
  }
  .honest {
    margin: 0;
    color: var(--ink-2);
  }
  .error {
    color: var(--accent);
  }
  .actions {
    grid-area: actions;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: var(--s-3);
  }
  .invite-note {
    margin: 0;
    padding: 6px 10px;
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
    font-size: var(--t-s);
    box-shadow: var(--shadow-sticker);
  }
  .invite-note.error {
    color: var(--accent);
  }
  /* Не wide: общий балл, партии и прослушивание идут одной колонкой (партии — рядом, если влезают). */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .coop-final {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        "head head"
        "team team"
        "listen listen"
        "self rival"
        "actions actions";
      gap: var(--s-4);
    }
    .part.self,
    .part.rival {
      rotate: 0deg;
    }
  }
  @media (max-width: 599px) {
    .coop-final {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "head" "team" "listen" "self" "rival" "actions";
    }
    .pic {
      width: 110px;
    }
  }
</style>
