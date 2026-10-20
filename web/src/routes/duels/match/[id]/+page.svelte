<script lang="ts">
  import { refreshAchievements } from "#lib/achievements.svelte.ts";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onDestroy, onMount } from "svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { api } from "#lib/api/http.ts";
  import type { MatchView, PlayerResult } from "#lib/api/types.ts";
  import { activeInvite, command, connect, live, resetMatch, serverNow } from "#lib/live/client.svelte.ts";
  import { plural } from "#lib/ui/format.ts";
  import { Capture, loadBacking, micError } from "#lib/audio/capture.ts";
  import { chooseMic, initMics, mics } from "#lib/audio/microphones.svelte.ts";
  import { asset, entryFor, loadCatalog, loadSong, songVersion } from "#lib/catalog.ts";
  import { ALGORITHM_VERSION, canonical, score } from "#lib/scoring/index.svelte.ts";
  import type { PitchFrame, ScoreResult, Song } from "#lib/scoring/types.ts";
  import { stage } from "#lib/ui/stage.svelte.ts";
  import PianoRoll from "#lib/ui/PianoRoll.svelte";
  import ResultTrace from "#lib/ui/ResultTrace.svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import { traceSeries } from "#lib/ui/series.ts";
  import Cat from "#lib/brand/Cat.svelte";
  import Cutout from "#lib/brand/Cutout.svelte";
  import Star from "#lib/brand/Star.svelte";
  import VuMeter from "#lib/ui/VuMeter.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Polaroid from "#lib/brand/Polaroid.svelte";
  import LyricStrip from "#lib/ui/LyricStrip.svelte";
  import { lineAt, loadWordTiming, type WordTiming } from "#lib/lyrics.ts";
  import { REASON_LABEL, compareAxes, hardestMoments, verdict, type DuelMoment } from "#lib/duel/analysis.ts";
  import { CurveVoices } from "#lib/audio/curve-voice.ts";
  import { inTurns, maskPoints, partSong } from "#lib/duel/coop.ts";
  import { mayShareVoice, ownVoice, rememberLags, sendVoice, sharingOf, type Upload } from "#lib/duel/coop-voice.ts";
  import CoopCue from "#lib/duel/CoopCue.svelte";
  import CoopResult, { type CoopFinals } from "#lib/duel/CoopResult.svelte";

  const HOP = 0.05;
  const id = $derived(page.params.id ?? "");

  let song = $state<Song | null>(null);
  let words = $state<WordTiming | null>(null);
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
  // «Вместе»: ходы по расписанию сервера; свой слот и имя партнёра для ярлыков сцены.
  const coop = $derived(view?.mode === "coop");
  const turns = $derived(view?.turns ?? []);
  const mySlot = $derived(me?.slot ?? 0);
  const partnerName = $derived(rival?.name ?? "друг");
  let coopFinals = $state<CoopFinals | null>(null);
  // Настоящие голоса «Вместе»: оба согласились до песни — своя запись (только свои ходы) уходит
  // партнёру сразу после песни; без согласия обоих звучит синтезированный голос.
  // Последний выбор самого игрока: голос уходит, только если он «делиться» И сервер видит согласие
  // обоих. Снятие галочки действует сразу, даже если состояние с ним ещё не пришло от сервера.
  let shareChoice = $state(false);
  const bothShare = $derived(coop && !!view && mayShareVoice(shareChoice, view.players));
  let myVoice = $state<Float32Array | null>(null);
  let voiceStatus = $state<Upload>("none");
  let sharing = $state(false);
  /** Отказ сервера по согласию (подтверждение команды или сообщение владельца матча). */
  let shareError = $state("");

  // После перезагрузки страницы до песни последний выбор — тот, что сервер уже знает.
  let shareTouched = false;
  $effect(() => {
    if (!shareTouched && coop && me && (view?.state === "waiting" || view?.state === "ready_check")) shareChoice = !!me.share_voice;
  });

  async function setShare(on: boolean) {
    if (!view) return;
    shareTouched = true;
    shareChoice = on;
    shareError = "";
    live.error = "";
    sharing = true;
    const r = await command({ type: "voice_share", match_id: view.match_id, on });
    sharing = false;
    if (!r.ok) shareError = r.error ?? "Не удалось изменить согласие.";
  }
  // Владелец матча отказывает сообщением, а не подтверждением (например, галочку поставили в
  // момент общего старта): показываем его у галочки и считаем выбор снятым.
  $effect(() => {
    if (coop && shareChoice && live.error && /поделиться голосом/i.test(live.error)) {
      shareError = live.error;
      shareChoice = false;
    }
  });
  /**
   * Снятие согласия после песни: сервер снимает флаг и удаляет загруженные голоса. Итог узнаёт,
   * принял ли сервер команду (true), и только тогда пишет «записи удалены». Свой выбор на странице
   * снимается сразу: голос больше не отправляется, даже если команда не дошла.
   */
  async function withdrawVoice(): Promise<boolean> {
    if (!view) return false;
    shareTouched = true;
    shareChoice = false;
    const r = await command({ type: "voice_share", match_id: view.match_id, on: false });
    return r.ok;
  }

  let voiceSent = false;
  /** Когда эта страница увидела конец песни: от него отсчитывается срок отправки (90 с, voices.rs). */
  let finishedSeenAt = 0;
  const UPLOAD_WINDOW_MS = 90_000;
  $effect(() => {
    const v = view;
    if (v?.state !== "finished" || !bothShare || !capture || voiceSent) return;
    voiceSent = true;
    finishedSeenAt = Date.now();
    myVoice = ownVoice(capture.recording(), v.turns ?? [], mySlot);
    void uploadVoice(v.match_id);
  });
  async function uploadVoice(matchId: string) {
    if (!myVoice) return;
    voiceStatus = "sending";
    const r = await sendVoice(matchId, myVoice);
    voiceStatus = r.ok ? "sent" : r.reason === "error" ? "failed" : r.reason;
  }
  // «Отправить ещё раз» — пока открыт срок отправки (с запасом в 2 с; окончательно решает сервер).
  const resendOpen = $derived(voiceStatus === "failed" && now - finishedSeenAt < UPLOAD_WINDOW_MS - 2_000);
  function resendVoice() {
    if (view && bothShare && resendOpen) void uploadVoice(view.match_id);
  }
  /**
   * Отправка для итога: после закрытия срока несохранённая запись — «срок прошёл»; если это
   * устройство пело, а на сервере согласны оба, но свой выбор здесь — «не делиться», запись не
   * отправлялась: для итога это снятое согласие.
   */
  const uploadState = $derived<Upload>(
    voiceStatus === "failed" && !resendOpen
      ? "late"
      : voiceStatus === "none" && micReady && !shareChoice && !!view && sharingOf(false, view.players) === "shared"
        ? "refused"
        : voiceStatus,
  );

  onMount(() => {
    const stopMics = initMics();
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

  // Как на /duels: кабинет при открытии страницы загружается после её монтирования, поэтому
  // подключение — в эффекте. Раньше после перезагрузки матча живое соединение не открывалось
  // вовсе, и команды (реванш, снятие согласия на голос) ждали без ответа.
  $effect(() => {
    if (account.profile) connect();
  });

  onDestroy(() => {
    stopListen();
    stopAudio();
    stage.dark = false;
    stage.focus = false;
  });

  $effect(() => {
    if (view && !song)
      loadSong(view.song.id)
        .then((s) => {
          song = s;
          void loadWordTiming(s).then((w) => (words = w));
        })
        .catch((e: Error) => (error = e.message));
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
    if (v?.state !== "finished" || !song || finals || coopFinals) return;
    void refreshAchievements();
    const s = song;
    const mine = capture ? canonical(capture.frames, s.duration_s) : Promise.resolve(null);
    if (v.mode === "coop") {
      // «Вместе»: каждая линия разбирается по эталону своей партии, как на сервере.
      const t = v.turns ?? [];
      const slot = mySlot;
      const other = rival?.slot ?? 1 - slot;
      void mine.then(async (curve) => {
        if (!curve) return;
        const myCurve = curve.map((f, i) => (inTurns(t, slot, i * HOP) ? f : { ...f, midi: null }));
        // После последнего хода партнёра сервер его точек не шлёт (там заранее пауза):
        // линия дополняется паузой до конца песни, а не считается неполной.
        const got = live.opponent;
        const theirCurve = got.some((q) => q != null) ? Array.from({ length: n }, (_, i) => ({ t: i * HOP, midi: got[i] == null ? null : got[i]! / 10 })) : null;
        const mineResult = await score(myCurve, partSong(s, t, slot));
        const theirs = theirCurve ? await score(theirCurve, partSong(s, t, other)) : null;
        coopFinals = { myCurve, mine: mineResult, theirCurve, theirs };
        // Задержки записей нужны настоящим голосам и после перезагрузки итога в этой вкладке.
        rememberLags(v.match_id, { mine: mineResult.lag, theirs: theirs?.lag ?? 0 });
      });
      return;
    }
    void mine.then(async (myCurve) => {
      const theirCurve = live.opponent.length === n ? rivalCurve : null;
      const mineResult = myCurve ? await score(myCurve, s) : null;
      const theirs = theirCurve ? await score(theirCurve, s) : null;
      if (mineResult && myCurve) finals = { mine: mineResult, theirs, myCurve, theirCurve };
    });
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
      // «Вместе»: на сервер уходят только свои ходы, остальное — пауза (сервер чужое и не примет).
      const own = (points: (number | null)[], from: number) => (view.mode === "coop" ? maskPoints(points, from, view.turns ?? [], mySlot) : points);
      while (sent < upto) {
        const to = Math.min(upto, sent + 20);
        const points = own(curve.slice(sent, to).map((f) => (f.midi === null ? null : Math.round(f.midi * 10))), sent);
        void command({ type: "perf", match_id: view.match_id, from: sent, points });
        sent = to;
      }
      if (done && sent >= n) {
        finished = true;
        clearInterval(sender);
        finalPoints = own(curve.map((f) => (f.midi === null ? null : Math.round(f.midi * 10))), 0);
        void command({ type: "finish", match_id: view.match_id, count: n });
        if (view.mode === "coop") {
          // Предварительный балл своей партии: та же кривая и эталон своих ходов, что у сервера.
          const masked = curve.map((f, i) => (finalPoints![i] === null ? { ...f, midi: null } : f));
          preliminary = (await score(masked, partSong(song, view.turns ?? [], mySlot))).score;
        } else preliminary = (await score(curve, song)).score;
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

  // Время песни: по часам AudioContext, на котором запланирована минусовка; без микрофона — по серверу.
  const songTime = () => (capture ? capture.ctx.currentTime - ctxStart : clock);

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

  // Реванш: нерейтинговая комната с той же песней для тех же двоих. Сопернику приходит
  // приглашение; если он нажал «Реванш» раньше, сервер сразу ставит в его комнату.
  // Переход идёт через страницу комнаты, как у обычной комнаты друга: прямой переход
  // /duels/match/<старый> → /duels/match/<новый> переиспользовал бы этот компонент вместе с
  // состоянием прошлого матча (минусовка не запускалась, на сервер уходила прошлая кривая).
  let rematching = $state(false);
  async function rematch() {
    if (!view || rematching) return;
    rematching = true;
    error = "";
    stopAudio();
    const matchId = view.match_id;
    if (live.queue?.status === "searching") await command({ type: "queue_leave" });
    const r = await command({ type: "rematch", match_id: matchId });
    rematching = false;
    const room = live.room;
    if (!r.ok || !room || room.rematch_of !== matchId) {
      error = r.error ?? "Не удалось открыть комнату реванша. Попробуй ещё раз.";
      return;
    }
    void goto(`/duels/room/${room.code}`);
  }

  // Рейтинговый поиск нового соперника.
  async function searchAgain() {
    if (!view) return;
    stopAudio();
    resetMatch();
    await command({ type: "queue_join" });
    void goto("/duels");
  }

  // Приглашение соперника на реванш именно этого матча, пока ждёт комната (15 минут).
  const invite = $derived.by(() => {
    const r = activeInvite(now);
    return r && r.rematch_of === view?.match_id ? r : null;
  });
  // Своя комната реванша: соперник уже видит приглашение на экране итога.
  const ownRematch = $derived(!!live.room && !live.room.invite && !!live.room.rematch_of && live.room.match_id === view?.match_id);

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

  // Разбор: оси обоих, линии в одной тональности, трудные места и прослушивание линий.
  const rows = $derived(compareAxes(mine?.axes, theirs?.axes));
  const rivalName = $derived(rival?.name ?? "Соперник");
  const traceData = $derived(
    song && finals ? traceSeries(song, finals.myCurve, finals.mine, finals.theirs && finals.theirCurve ? { frames: finals.theirCurve, result: finals.theirs } : null) : [],
  );
  const hard = $derived<DuelMoment[]>(finals ? hardestMoments(finals.mine, finals.theirs) : []);
  const lineText = (t: number) => {
    const i = song ? lineAt(song.lyrics, t + 0.3) : -1;
    return i >= 0 && song ? song.lyrics[i].text.replaceAll(" · ", " ") : "";
  };
  const secs = (t: number) => t.toFixed(1).replace(".", ",");

  let voices: CurveVoices | null = null;
  let listening = $state<{ who: "mine" | "theirs" | "both"; from: number; to: number } | null>(null);
  let listenAt = $state(0);
  let focus = $state<[number, number] | null>(null);
  let accompaniment: AudioBuffer | null = null;
  let listenTicket = 0;
  let listenError = $state("");

  // Минус песни под линиями готовится заранее: звук должен стартовать прямо по нажатию.
  $effect(() => {
    if (!showDetails || !song || accompaniment) return;
    const s = song;
    void loadCatalog()
      .then(async (list) => {
        if (!entryFor(s.id, list)?.stems) return;
        const r = await fetch(asset(s.id, "instrumental.mp3"));
        if (r.ok) accompaniment = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await r.arrayBuffer());
      })
      .catch(() => {});
  });

  function stopListen() {
    listenTicket++;
    voices?.stop();
    voices = null;
    listening = null;
    listenAt = 0;
  }

  async function listen(who: "mine" | "theirs" | "both", m: DuelMoment | null = null) {
    if (!finals || !song) return;
    stopListen();
    const t = listenTicket;
    const f = finals;
    const from = m ? Math.max(0, m.start_s - 0.3) : 0;
    const to = m ? Math.min(song.duration_s, m.end_s + 0.3) : song.duration_s;
    // Задержка записи каждого компенсирована, как в оценке.
    const mineLine = { frames: f.myCurve.map((p) => ({ ...p, t: p.t - f.mine.lag })), pan: who === "both" ? -0.45 : 0, gain: who === "both" ? 0.75 : 1 };
    const theirLine = f.theirCurve && f.theirs
      ? {
          frames: f.theirCurve.map((p) => ({ ...p, t: p.t - f.theirs!.lag })),
          // Вместе — соперник в твоей тональности, чтобы слышать разницу в мелодии, а не в регистре.
          shift: who === "both" ? f.mine.shift - f.theirs.shift : 0,
          pan: who === "both" ? 0.45 : 0,
          gain: who === "both" ? 0.75 : 1,
        }
      : null;
    const lines = who === "mine" ? [mineLine] : who === "theirs" ? (theirLine ? [theirLine] : []) : theirLine ? [mineLine, theirLine] : [mineLine];
    if (!lines.length) return;
    listenError = "";
    focus = m ? [m.start_s, m.end_s] : null;
    try {
      const v = await CurveVoices.play({ lines, backing: accompaniment, from, to, onEnd: () => t === listenTicket && stopListen() });
      if (t !== listenTicket) return v.stop();
      voices = v;
      listening = { who, from, to };
      const tick = () => {
        if (t !== listenTicket || !voices) return;
        listenAt = voices.position;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      listenError = `Не удалось запустить звук: ${(e as Error).message}`;
    }
  }
</script>

<svelte:window {onkeydown} />
<!-- Соперник найден, а вкладка в фоне: время на подтверждение ограничено, заголовок вкладки зовёт обратно. -->
<svelte:head><title>{view?.kind === "rated" && view.state === "waiting" && me && !me.accepted ? "Соперник найден! Прими вызов — Перепев" : `${coop ? "Вместе" : "Дуэль"} — Перепев`}</title></svelte:head>


{#snippet vs()}
  <span class="vs" aria-hidden="true">
    <svg viewBox="0 0 120 120"><polygon points="60,2 72,34 106,18 90,50 118,62 88,74 102,108 70,90 60,118 48,90 16,106 30,74 2,60 32,48 16,16 48,32" fill="#a81d1d" stroke="#0d0c0d" stroke-width="3" stroke-linejoin="round" /></svg>
    <b>VS<small style:display="block" style:font-size="0.3em" style:letter-spacing="0">против</small></b>
  </span>
{/snippet}

{#if !account.profile && account.loaded}
  <section class="pad"><p class="notice">Войди в кабинет, чтобы участвовать в дуэли. <a class="btn" href={signInHref(page.url.pathname)}>Войти</a></p></section>
{:else if !view || !song}
  <section class="pad">
    {#if error}<p class="notice error" role="alert">{error}</p><a class="btn" href="/duels">К дуэлям</a>{:else}<p class="muted" role="status">Загружаем матч…</p>{/if}
  </section>
{:else if view.state === "created" || view.state === "waiting"}
  <section class="step" class:wide={!(view.kind === "friend" && view.players.length < 2)}>
    {#if view.kind === "friend" && view.players.length < 2}
      <TitleStrip text={ownRematch ? (coop ? "Ещё раз вместе: ждём друга" : "Реванш: ждём соперника") : "Ждём друга"} />
      <h2 class="kind">{coop ? "Вместе: поёте по очереди, без рейтинга" : "Дуэль с другом, без рейтинга"}</h2>
      {#if ownRematch && coop}
        <p class="lead">Приглашение уже отправлено: у друга на экране итога появилась кнопка «Спеть ещё раз». Песня та же — «{view.song.title}», снова по очереди. Можно и переслать ссылку.</p>
      {:else if ownRematch}
        <p class="lead">Приглашение уже отправлено: у соперника на экране итога появилась кнопка «Принять реванш». Песня та же — «{view.song.title}», рейтинг не меняется. Можно и переслать ссылку.</p>
      {:else if coop}
        <p class="lead">Отправь ссылку на комнату. Песня: {view.song.title}. Споёте её по очереди, по строке, а в конце послушаете целиком.</p>
      {:else}
        <p class="lead">Отправь ссылку на комнату. Песня: {view.song.title}.</p>
      {/if}
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
        <h2 class="at kind2" style:--x="4%" style:--y="14%">{view.kind === "rated" ? "Рейтинговая дуэль" : "Дуэль с другом"} · «{view.song.title}», {Math.round(view.song.duration_s)} {plural(Math.round(view.song.duration_s), ["секунда", "секунды", "секунд"])}</h2>
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
          <span class="pic"><Polaroid><Cat mood="groove" tint="blue" size="88%" /></Polaroid></span>
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
      <TitleStrip text="Подготовка" />
      <h2 class="kind">{view.kind === "rated" ? "Рейтинговая дуэль" : coop ? "Вместе, по очереди, без рейтинга" : "Дуэль с другом, без рейтинга"} · «{view.song.title}»</h2>
      {#if coop && turns.length}
        <p class="coop-plan sheet small">
          Поёте по очереди: {turns.length} {plural(turns.length, ["ход", "хода", "ходов"])}, в каждом строка или две коротких. {turns[0].slot === mySlot ? "Начинаешь ты." : `Начинает ${partnerName}.`}
          На сцене твои строки помечены <b class="tag mine">Твоя строка</b>, строки друга — <b class="tag partner">Поёт {partnerName}</b>; перед каждым ходом появится подсказка.
        </p>
      {/if}
      {#if coop}
        <label class="share sheet small">
          <input type="checkbox" checked={shareChoice} disabled={sharing} onchange={(e) => setShare(e.currentTarget.checked)} />
          <span>
            <b>Поделиться голосом с партнёром для общего прослушивания</b>
            Если согласитесь оба, после песни вы услышите настоящие голоса друг друга, каждый в своих строках. На сервер уходит запись только твоих ходов, сразу после песни; она удаляется не позже чем через 10 минут. Без согласия обоих в конце звучит синтезированный голос по вашим мелодиям.
            Снять согласие можно в любой момент, и после песни: копия на сервере удалится сразу. Если страница партнёра уже загрузила твою запись, она останется в ней, пока партнёр не закроет страницу.
            <i class="share-state">{rival?.share_voice ? `${partnerName}: согласие есть` : `${partnerName}: пока без согласия`}{bothShare ? ". Согласны оба: после песни прозвучат ваши настоящие голоса." : ""}</i>
            {#if shareError}<em class="share-error" role="alert">{shareError}</em>{/if}
          </span>
        </label>
      {/if}
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
        Надень наушники. Пауза в живом матче не предусмотрена: общий таймер идёт для обоих.
        {#if coop && shareChoice}
          Партнёру и серверу уходит линия высоты твоих ходов с шагом 50 мс и служебные события, а запись голоса твоих ходов — только если согласились оба, после песни; она удаляется не позже чем через 10 минут.
        {:else}
          {coop ? "Партнёру и серверу уходит только линия высоты твоих ходов" : "Сопернику и серверу уходит только линия высоты"} с шагом 50 мс и служебные события; звук остаётся в браузере.
        {/if}
        Кривые матча хранятся 30 дней для проверки результата.
      </p>
    </div>
    <div class="gear" aria-hidden="true">
      <Cat mood={micReady ? "listening" : "idle"} size={180} />
      {#if micReady}<div class="vu"><VuMeter value={level} label="Уровень микрофона" /></div>{/if}
    </div>
  </section>
{:else if singing || view.state === "collecting"}
  <section class="stage" aria-label={coop ? "Пение вместе" : "Пение в дуэли"}>
    <header class="deck">
      <span class="singing-mascot" aria-hidden="true"><Cat mood="singing" size={64} /></span>
      <h1 class="label">{view.song.title}</h1>
      <span class="chip" class:warn={live.lost} role="status">
        {!live.lost ? "Соединение в норме" : live.offline ? "Нет сети. Запись идёт, линия дойдёт после переподключения" : "Связь прервалась, переподключаемся. Запись идёт"}
      </span>
      <span class="counter mono">{Math.max(0, Math.floor(clock))} / {Math.round(view.song.duration_s)} с</span>
      <button class="key" onclick={() => (exitOpen = true)}><span aria-hidden="true">■</span>Выйти</button>
    </header>
    <LyricStrip {song} {words} time={songTime} turns={coop ? turns : null} slot={mySlot} partner={partnerName} />
    <div class="roll sheet">
      <PianoRoll {song} frames={() => capture?.frames ?? []} time={songTime} rival={rivalCurve} label={coop ? "Мелодия: эталон, твой голос и партнёр пунктиром" : "Мелодия: эталон, твой голос и соперник пунктиром"} />
      {#if coop && singing}<CoopCue {turns} slot={mySlot} partner={partnerName} time={songTime} />{/if}
      {#if view.state === "countdown" && clock < 0}<div class="countdown" aria-live="polite"><span>{Math.ceil(-clock)}</span></div>{/if}
      {#if view.state === "collecting"}
        <div class="overlay">
          <b>Сверяем результаты…</b>
          {#if preliminary != null}<span>{coop ? `Предварительный балл твоей партии ${preliminary.toFixed(1)}. Окончательный и общий посчитает сервер.` : `Твой предварительный балл ${preliminary.toFixed(1)}. Окончательный посчитает сервер.`}</span>{/if}
          {#if !micReady}<span>Это устройство не записывало попытку.</span>{/if}
        </div>
      {/if}
    </div>
    <div class="legend">
      <span class="l-self">Ты</span>
      <span class="l-rival">{rival?.name}</span>
      <span class="dim mono">Твоя линия: отправлено {sent} из {n} {plural(n, ["точки", "точек", "точек"])}{live.lost && live.pending ? `, ещё ${live.pending} ${plural(live.pending, ["пакет ждёт", "пакета ждут", "пакетов ждут"])} связи` : ""}</span>
    </div>
  </section>
{:else if view.state === "finished" && view.result && coop}
  <CoopResult {view} {me} partner={rival} {song} finals={coopFinals} voice={{ recorded: micReady, mine: myVoice, upload: uploadState, canResend: resendOpen }} onwithdraw={withdrawVoice} onresend={resendVoice} {invite} {rematching} {error} reason={reasons[view.end_reason ?? ""] ?? ""} onrematch={rematch} onexit={resetMatch} />
{:else if view.state === "finished" && view.result}
  <section class="final">
    <!-- Основная композиция и подробности занимают одно место. -->
    <div class="scene duel-scene" hidden={showDetails}>
      <div class="at" style:--x="2%" style:--y="3%"><TitleStrip text="Дуэль" tag="div" /></div>
      <div class="at headline" style:--x="22%" style:--y="3%"><Cutout tag="h1" text={headline(mine)} size="clamp(34px, 3.4cqi, 64px)" seed={3} /></div>
      <h2 class="at kind2" style:--x="4%" style:--y="14%">{view.result.rated ? "Рейтинговая дуэль" : "Дуэль с другом, без рейтинга"} · «{view.song.title}»{view.result.technical ? ", техническое решение" : ""}</h2>
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
      <div class="at center-actions" style:--x="38%" style:--y="62%" style:--w="21%">
        {#if invite}
          <p class="invite-note" role="status">{rival?.name ?? "Соперник"} зовёт на реванш: та же песня, без рейтинга.</p>
          <a class="btn btn-primary" href="/duels/room/{invite.code}">Принять реванш</a>
        {:else}
          <button class="btn btn-primary" disabled={rematching} onclick={rematch} title="Та же песня с тем же соперником, без рейтинга">{rematching ? "Открываем комнату…" : view.kind === "rated" ? "Реванш без рейтинга" : "Реванш"}</button>
          {#if view.kind === "rated"}<button class="btn" onclick={searchAgain}>Новый соперник</button>{/if}
        {/if}
        <a class="btn" href="/duels" onclick={resetMatch}>К дуэлям</a>
        <button class="btn btn-quiet" onclick={() => showDetails = true}>Разбор и прослушивание</button>
        {#if error}<p class="invite-note error" role="alert">{error}</p>{/if}
      </div>
      <span class="at deco" style:--x="90%" style:--y="4%" style:--w="4%" style:--r="12deg"><Star variant="print" size="100%" /></span>
      <span class="at deco" style:--x="3%" style:--y="60%" style:--w="3.5%" style:--r="-12deg"><Star variant="outline" size="100%" /></span>
    </div>

    <div class="details" hidden={!showDetails}>
      <div class="details-head"><TitleStrip text="Разбор дуэли" /><button class="btn" onclick={() => { stopListen(); showDetails = false; }}>← К результату</button></div>
      {#if view.result.technical}<p class="notice">{reasons[view.end_reason ?? ""] ?? ""} Неполная кривая не оценивается: результат технический.</p>{/if}
      <div class="compare sheet">
        <table class="axes-table">
          <caption class="visually-hidden">Сравнение по осям оценки</caption>
          <thead>
            <tr><th scope="col">Ось и вес в балле</th><th scope="col" class="self">Ты</th><th scope="col" class="rival">{rivalName}</th><th scope="col">Разница</th></tr>
          </thead>
          <tbody>
            {#each rows as r (r.key)}
              <tr>
                <th scope="row">{r.label} <small>{r.weight} % · {r.hint}</small></th>
                {#each [{ v: r.mine, cls: "self", ahead: r.better === "mine" }, { v: r.theirs, cls: "rival", ahead: r.better === "theirs" }] as c (c.cls)}
                  <td class={c.cls} class:ahead={c.ahead}>
                    <span class="num mono">{c.v ?? "—"}</span>
                    <span class="bar" aria-hidden="true"><i style:width="{c.v ?? 0}%"></i></span>
                  </td>
                {/each}
                <td class="diff mono">{r.diff == null ? "—" : r.better === "tie" ? "вровень" : signedNum(r.diff)}</td>
              </tr>
            {/each}
            <tr class="total">
              <th scope="row">Итоговый балл</th>
              <td class="self"><span class="num mono">{mine?.score != null ? mine.score.toFixed(1) : "—"}</span></td>
              <td class="rival"><span class="num mono">{theirs?.score != null ? theirs.score.toFixed(1) : "—"}</span></td>
              <td class="diff mono">{mine?.score != null && theirs?.score != null ? signedNum(Math.round((mine.score - theirs.score) * 10) / 10) : "—"}</td>
            </tr>
          </tbody>
        </table>
        <p class="verdict">{verdict(rows, rivalName)}</p>
        {#if view.result.rated}
          <p class="small">Ты: {mine?.standing}{delta(mine) != null ? `, рейтинг ${signedNum(delta(mine)!)}` : ""}. {rivalName}: {theirs?.standing}{delta(theirs) != null ? `, рейтинг ${signedNum(delta(theirs)!)}` : ""}.</p>
        {/if}
      </div>
      {#if finals}
        <div class="trace sheet graph">
          <ResultTrace data={traceData} duration={song.duration_s} window={focus} label="Две линии в твоей тональности: сплошная — ты, пунктир — соперник" />
          {#if listening}<span class="playhead" aria-hidden="true" style:left="calc(4px + {(listenAt / song.duration_s) * 100}% - {(listenAt / song.duration_s) * 8}px)"></span>{/if}
        </div>
        <div class="listen sheet">
          <b>Переслушать</b>
          <div class="listen-buttons">
            <button class="btn" aria-pressed={listening?.who === "mine" && !focus} onclick={() => listen("mine")}>▶ Как спел ты</button>
            <button class="btn" disabled={!finals.theirCurve} aria-pressed={listening?.who === "theirs" && !focus} onclick={() => listen("theirs")}>▶ Как спел {rivalName}</button>
            <button class="btn" disabled={!finals.theirCurve} aria-pressed={listening?.who === "both" && !focus} onclick={() => listen("both")}>▶ Оба вместе</button>
            <button class="btn btn-quiet" disabled={!listening} onclick={stopListen}>■ Стоп</button>
            {#if listening}<span class="mono small" aria-live="off">{secs(listenAt)} / {secs(listening.to)} с</span>{/if}
          </div>
          <p class="small honest">Голос в дуэли не записывается. Звучит синтезированный голос по линии высоты каждого — мелодия и ритм, без тембра и слов — под минус песни. «Оба вместе»: соперник переведён в твою тональность, голоса разведены влево и вправо.</p>
          {#if listenError}<p class="small error" role="alert">{listenError}</p>{/if}
        </div>
        {#if hard.length}
          <div class="moments sheet">
            <b>Трудные места</b>
            <ol>
              {#each hard as m (m.start_s)}
                <li class:active={focus?.[0] === m.start_s}>
                  <span class="when mono">{secs(m.start_s)}–{secs(m.end_s)} с</span>
                  {#if lineText(m.start_s)}<span class="line">«{lineText(m.start_s)}»</span>{/if}
                  <span class="side self">Ты: {m.mineMoment ? REASON_LABEL[m.mineMoment.reason] : "чисто"}</span>
                  <span class="side rival">{rivalName}: {m.theirsMoment ? REASON_LABEL[m.theirsMoment.reason] : finals.theirs ? "чисто" : "нет линии"}</span>
                  <button class="btn btn-quiet" onclick={() => listen(finals?.theirCurve ? "both" : "mine", m)}>▶ Послушать</button>
                </li>
              {/each}
            </ol>
          </div>
        {/if}
      {:else}
        <p class="notice">Линии, трудные места и прослушивание доступны сразу после матча на устройстве, где ты пел: голос не записывается, а линии сохраняются только для проверки результата.</p>
      {/if}
      <p class="small muted">Оба участника видят этот же подтверждённый сервером результат. Линии и трудные места пересчитаны в браузере тем же ядром, поэтому могут немного отличаться от итога.</p>
      {#if invite}
        <p class="notice">{rivalName} зовёт на реванш: та же песня, без рейтинга. <a class="btn" href="/duels/room/{invite.code}">Принять реванш</a></p>
      {/if}
    </div>
  </section>
{:else}
  <section class="step failed">
    <div class="fail-cat" aria-hidden="true"><Cat mood="unplugged" size={180} /></div>
    <div class="fail-note sheet">
      <h1>{view.state === "cancelled" ? "Матч отменён" : "Технический сбой"}</h1>
      <p>{view.end_reason === "accept_timeout" && me && !me.accepted ? "Ты не подтвердил участие вовремя, поэтому поиск остановлен." : (reasons[view.end_reason ?? ""] ?? "")} Рейтинг не изменился.</p>
      {#if live.queue?.status === "searching"}<p role="status">Ты снова в поиске с прежним приоритетом.</p>{/if}
      <a class="btn btn-primary" href="/duels" onclick={resetMatch}>К дуэлям</a>
    </div>
  </section>
{/if}

<ConfirmDialog
  open={exitOpen}
  title={coop ? "Выйти из комнаты?" : "Выйти из дуэли?"}
  text={view && ["countdown", "singing", "collecting"].includes(view.state) ? (coop ? "Пение уже началось: выход остановит совместное исполнение, общий балл не будет посчитан." : "Пение уже началось: выход засчитывается как техническое поражение. Таймер не останавливается.") : "Матч будет отменён без изменения рейтинга."}
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
  /* Вид дуэли — подзаголовок-наклейка на бумаге: на тёмной стене не сливается с фоном. */
  .kind,
  .kind2 {
    justify-self: start;
    width: fit-content;
    max-width: 100%;
    margin: 0;
    padding: 3px 12px 5px;
    background: var(--kraft) var(--tex-paper);
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: clamp(1.2rem, 1.5cqi, 1.7rem);
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.15;
    rotate: -1deg;
    box-shadow: var(--shadow-sticker), 0 3px 8px rgb(0 0 0 / 0.45);
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
  .coop-plan {
    max-width: 62ch;
    margin: 0;
    padding: var(--s-3) var(--s-4);
    line-height: 1.6;
  }
  .coop-plan .tag {
    padding: 0.05em 0.4em 0.1em;
    border-radius: 3px;
    color: var(--paper-2);
    font-size: 0.9em;
    white-space: nowrap;
  }
  .coop-plan .tag.mine {
    background: var(--accent);
  }
  .coop-plan .tag.partner {
    background: var(--rival);
  }
  .share {
    display: flex;
    align-items: flex-start;
    gap: var(--s-3);
    max-width: 62ch;
    padding: var(--s-3) var(--s-4);
    cursor: pointer;
  }
  .share input {
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 2px;
    accent-color: var(--accent);
  }
  .share b {
    display: block;
  }
  .share-error {
    display: block;
    margin-top: var(--s-1);
    font-style: normal;
    font-weight: 700;
    color: var(--accent);
  }
  .share-state {
    display: block;
    margin-top: var(--s-1);
    font-style: normal;
    font-weight: 600;
    color: var(--rival);
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
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    gap: var(--s-3);
    height: calc(100dvh - var(--s-6));
    padding-top: var(--s-4);
  }
  /* Пять предметов деки: кот, название, связь, счётчик, «Выйти» (кнопка — справа, по размеру текста). */
  .deck {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    grid-template-areas: "cat title chip counter key";
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
  .deck .singing-mascot { grid-area: cat; }
  .deck .label { grid-area: title; }
  .deck .chip { grid-area: chip; }
  .deck .counter { grid-area: counter; }
  .deck .key { grid-area: key; justify-self: end; }
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
  .details-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--s-3); }
  .trace {
    position: relative;
    height: 150px;
    padding: var(--s-2) var(--s-3);
  }
  .playhead {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 2px;
    margin-left: var(--s-3);
    background: var(--ink);
    pointer-events: none;
  }
  .compare,
  .listen,
  .moments {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-5);
  }
  .axes-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--t-s);
  }
  .axes-table th,
  .axes-table td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px dashed var(--line-strong);
    vertical-align: middle;
  }
  .axes-table thead th {
    font-weight: 700;
    color: var(--ink-2);
  }
  .axes-table thead th.self {
    box-shadow: inset 0 -3px 0 var(--accent);
  }
  .axes-table thead th.rival {
    box-shadow: inset 0 -3px 0 var(--rival);
  }
  .axes-table tbody th {
    font-weight: 600;
  }
  .axes-table small {
    display: block;
    font-weight: 400;
    color: var(--ink-3);
  }
  .axes-table td {
    min-width: 7rem;
  }
  .num {
    display: inline-block;
    min-width: 2.6em;
  }
  .bar {
    display: inline-block;
    width: calc(100% - 3.2em);
    height: 6px;
    vertical-align: middle;
    background: rgb(0 0 0 / 0.08);
  }
  .bar i {
    display: block;
    height: 100%;
  }
  td.self .bar i {
    background: var(--accent);
  }
  td.rival .bar i {
    background: var(--rival);
  }
  td.ahead .num {
    font-weight: 700;
  }
  td.ahead.self .num::after,
  td.ahead.rival .num::after {
    content: " ★";
    font-size: 0.8em;
  }
  .total th,
  .total td {
    border-bottom: 0;
    font-size: var(--t-m);
  }
  .verdict {
    margin: 0;
    font-weight: 600;
  }
  .listen-buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-3);
  }
  .listen-buttons [aria-pressed="true"] {
    box-shadow: inset 0 0 0 2px var(--ink);
  }
  .honest {
    margin: 0;
    color: var(--ink-2);
  }
  .moments ol {
    display: grid;
    gap: var(--s-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .moments li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px var(--s-3);
    padding: 6px 8px;
    border-left: 3px solid var(--line-strong);
  }
  .moments li.active {
    border-left-color: var(--accent);
    background: rgb(242 215 78 / 0.25);
  }
  .moments .when {
    grid-row: span 2;
  }
  .moments .line {
    font-weight: 600;
  }
  .moments .side {
    grid-column: 2;
    font-size: var(--t-s);
  }
  .moments .side.self::before,
  .moments .side.rival::before {
    content: "";
    display: inline-block;
    width: 14px;
    height: 3px;
    margin-right: 6px;
    vertical-align: middle;
    background: var(--accent);
  }
  .moments .side.rival::before {
    background: repeating-linear-gradient(90deg, var(--rival) 0 4px, transparent 4px 7px);
  }
  .moments li .btn {
    grid-column: 3;
    grid-row: 1 / span 3;
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
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas: "cat title key" "chip chip counter";
      gap: var(--s-2) var(--s-3);
    }
    .deck .chip { justify-self: start; }
  }
  /* Узкий экран: таблица осей без пояснений, полоски под числами, без минимальной ширины. */
  @media (max-width: 599px) {
    .compare,
    .listen,
    .moments {
      padding: var(--s-3);
    }
    .axes-table th small {
      display: none;
    }
    .axes-table td {
      min-width: 0;
    }
    .bar {
      display: block;
      width: 100%;
      margin-top: 2px;
    }
    .moments li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .moments .when {
      grid-row: auto;
    }
    .moments .side,
    .moments .line {
      grid-column: 1;
    }
    .moments li .btn {
      grid-column: 2;
      grid-row: 1 / span 4;
    }
  }
  /* Короткий экран (телефон боком): дека в одну строку без кота, график сжимается по высоте,
     чтобы сцена со словами помещалась в окно без прокрутки. */
  @media (max-height: 520px) {
    .stage {
      gap: var(--s-2);
      height: calc(100dvh - var(--s-3));
      padding-top: var(--s-2);
    }
    .deck {
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      grid-template-areas: "title chip counter key";
      gap: var(--s-2);
      padding: 4px 8px;
    }
    .deck .singing-mascot {
      display: none;
    }
    .label {
      font-size: 1.2rem;
    }
    .roll {
      min-height: 0;
      padding: var(--s-1) var(--s-2);
    }
    .legend {
      gap: var(--s-3);
      font-size: var(--t-xs);
    }
  }
</style>
