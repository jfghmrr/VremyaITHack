import { useEffect, useRef, useState, useMemo } from "react";
import { Brand, cover } from "./Brand";
import { Catalog } from "./LibraryScreens";
import { ProfileScreen } from "./ProfileScreen";
import { useProfile } from "./profile";
import { Practice } from "./Practice";
import type { Moment } from "../scoring";
import { Capture } from "../audio/capture";
import { asset, loadBacking, loadCatalog, loadSong } from "../audio/assets";
import { useApp } from "../store";
import { scorePerformance, type ScoreResult } from "../scoring";
import type { PitchFrame, Recording, Song, SongInfo } from "../types";
import { MicTrace } from "./MicTrace";
import { PianoRoll } from "./PianoRoll";
import { ResultTrace, CountScore } from "./ResultTrace";
import { Review } from "./Review";
import { Duel } from "./Duel";
import { ExitDialog } from "./ExitDialog";
import { useMicrophones } from "./useMicrophones";
import { decodeChallenge, type Challenge } from "../challenge/codec";
type Screen = "home" | "mic" | "sing" | "result" | "register" | "practice";
const axisNames = {
  intervals: "Интервалы",
  rhythm: "Ритм",
  stability: "Стабильность",
  coverage: "Покрытие",
};
const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}`;
export function App() {
  const { name, setName } = useApp();
  const inputs = useMicrophones();
  const journal = useProfile();
  const [practiceMoment, setPracticeMoment] = useState<Moment | null>(null);
  const previousAccount = useRef<string | null>(null);
  useEffect(() => {
    const next = journal.profile?.id || null;
    if (previousAccount.current && previousAccount.current !== next) {
      clean();
      setResult(null);
      recording.current = null;
      frames.current = [];
      setPracticeMoment(null);
      setName(journal.profile?.name || "");
    }
    previousAccount.current = next;
    if (journal.profile) setName(journal.profile.name);
  }, [journal.profile, setName]);
  const [paused, setPaused] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const resumeAfterDialog = useRef(false);
  const transportBusy = useRef(false);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  const [screen, setScreen] = useState<Screen>("home");
  const [catalog, setCatalog] = useState<SongInfo[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [live, setLive] = useState<PitchFrame>({ t: 0, midi: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(-3);
  const [result, setResult] = useState<ScoreResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [idealView, setIdealView] = useState(false);
  const [resultTab, setResultTab] = useState<"review" | "duel">("review");
  const [ghost, setGhost] = useState<Challenge | null>(null);
  const capture = useRef<Capture | null>(null);
  const backing = useRef<AudioBuffer | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const recording = useRef<Recording | null>(null);
  const frames = useRef<PitchFrame[]>([]);
  const raf = useRef(0);
  const request = useRef(0);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    loadCatalog()
      .then(setCatalog)
      .catch((e) => setError(String(e.message)));
    return () => {
      request.current++;
      cancelAnimationFrame(raf.current);
      capture.current?.stop();
      previewAudio.current?.pause();
    };
  }, []);
  useEffect(() => {
    const read = () => {
      try {
        const incoming = decodeChallenge(location.hash);
        setGhost(incoming);
        if (incoming) {
          clean();
          setScreen("home");
        }
      } catch (e) {
        setGhost(null);
        setError((e as Error).message);
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const ghostResult = useMemo(
    () =>
      ghost && song && ghost.songId === song.id
        ? scorePerformance(ghost.curve, song)
        : null,
    [ghost, song],
  );
  const ghostFrames = useMemo(
    () =>
      ghost && ghostResult
        ? ghost.curve.map((f) => ({ ...f, t: f.t - ghostResult.lag }))
        : undefined,
    [ghost, ghostResult],
  );
  function clean() {
    setPaused(false);
    setBusy(false);
    request.current++;
    cancelAnimationFrame(raf.current);
    try {
      source.current?.stop();
    } catch {
      /* Already stopped. */
    }
    source.current = null;
    capture.current?.stop();
    capture.current = null;
    setReady(false);
    previewAudio.current?.pause();
    setPreview(null);
  }
  function home() {
    clean();
    setScreen("home");
    setError("");
  }
  function go(next: Screen) {
    clean();
    setError("");
    setIdealView(false);
    setScreen(next);
  }
  async function select(id: string) {
    clean();
    const ticket = ++request.current;
    setBusy(true);
    setError("");
    try {
      const s = await loadSong(id);
      if (
        ghost &&
        ghost.songId === id &&
        Math.abs(ghost.curve.length * 0.05 - s.duration_s) > 0.1
      )
        throw new Error(
          "Длительность вызова не совпадает с этой версией песни.",
        );
      if (ticket !== request.current) return;
      setSong(s);
      setResult(null);
      recording.current = null;
      frames.current = [];
      setScreen("mic");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось открыть песню");
    } finally {
      setBusy(false);
    }
  }
  async function enableMic(deviceId = inputs.selected) {
    if (!song) return;
    previewAudio.current?.pause();
    setPreview(null);
    const ticket = ++request.current;
    capture.current?.stop();
    capture.current = null;
    setReady(false);
    setLive({ t: 0, midi: null, rms: 0 });
    setBusy(true);
    setError("");
    try {
      const mic = await Capture.open((f) => setLive(f), deviceId);
      if (ticket !== request.current) {
        mic.stop();
        return;
      }
      capture.current = mic;
      mic.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (capture.current !== mic) return;
        clean();
        setExitOpen(false);
        setScreen("mic");
        setError(
          "Микрофон отключён. Подключи устройство и выбери вход заново.",
        );
      });
      await inputs.refresh();
      backing.current = await loadBacking(mic.ctx, song);
      if (ticket === request.current) setReady(true);
    } catch (e) {
      if (ticket !== request.current) return;
      await inputs.refresh();
      capture.current?.stop();
      capture.current = null;
      const err = e as Error;
      setError(
        err.name === "NotAllowedError"
          ? "Нет доступа к микрофону. Разрешите доступ в настройках браузера и обновите страницу."
          : err.name === "NotFoundError" || err.name === "OverconstrainedError"
            ? "Выбранный микрофон не найден. Подключи его или выбери другой вход в списке."
            : err.name === "NotReadableError"
              ? "Микрофон занят или недоступен. Закрой другие приложения со звуком и попробуй ещё раз."
              : err.message,
      );
    } finally {
      setBusy(false);
    }
  }
  function start() {
    const mic = capture.current;
    if (!mic || !song || !backing.current) return;
    setError("");
    setPaused(false);
    void mic.ctx.resume();
    const at = mic.ctx.currentTime + 3;
    mic.begin(at, song.duration_s);
    frames.current = mic.frames;
    setTime(-3);
    setScreen("sing");
    const audio = mic.ctx.createBufferSource();
    audio.buffer = backing.current;
    audio.connect(mic.ctx.destination);
    audio.start(at);
    source.current = audio;
    const tick = () => {
      const t = mic.ctx.currentTime - at;
      setTime(t);
      if (t < song.duration_s + 0.12) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      recording.current = mic.recording();
      frames.current = [...mic.frames];
      clean();
      setBusy(true);
      setTimeout(() => {
        const scored = scorePerformance(frames.current, song);
        setResult(scored);
        void journal.save({
          songId: song.id,
          title: song.title,
          name: name.trim() || "Гость",
          score: scored.score,
          axes: scored.axes,
          shift: scored.shift,
          moments: scored.moments,
        });
        setIdealView(false);
        setResultTab(ghostResult ? "duel" : "review");
        setBusy(false);
        setScreen("result");
      }, 30);
    };
    raf.current = requestAnimationFrame(tick);
  }
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && screen === "sing") {
        clean();
        setExitOpen(false);
        setScreen("mic");
        setError(
          "Запись прервана: вкладка ушла в фон. Начни ещё раз, чтобы сохранить точный ритм.",
        );
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [screen]);
  async function setTransportPause(value: boolean) {
    const mic = capture.current;
    if (!mic || transportBusy.current) return;
    transportBusy.current = true;
    try {
      if (value) await mic.ctx.suspend();
      else await mic.ctx.resume();
      setPaused(value);
    } catch {
      setError("Не удалось переключить паузу. Начни попытку заново.");
    } finally {
      transportBusy.current = false;
    }
  }
  async function requestHome() {
    if (screen !== "sing") {
      home();
      return;
    }
    resumeAfterDialog.current = !paused;
    await setTransportPause(true);
    setExitOpen(true);
  }
  function cancelExit() {
    setExitOpen(false);
    if (resumeAfterDialog.current) void setTransportPause(false);
  }
  function confirmExit() {
    setExitOpen(false);
    home();
  }
  keys.current = (e) => {
    if (
      e.defaultPrevented ||
      e.repeat ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      exitOpen
    )
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      void requestHome();
      return;
    }
    if (
      (e.target as HTMLElement)?.closest(
        'input,select,textarea,[contenteditable="true"]',
      )
    )
      return;
    if (
      e.code === "Space" &&
      (screen === "sing" || (screen === "mic" && ready && !busy))
    ) {
      e.preventDefault();
      if (screen === "sing") void setTransportPause(!paused);
      else start();
    }
    if (
      e.key === "Enter" &&
      screen === "mic" &&
      !busy &&
      !(e.target as HTMLElement)?.closest("button")
    ) {
      e.preventDefault();
      if (ready) start();
      else void enableMic();
    }
    if (e.key.toLowerCase() === "r" && screen === "result" && song && !busy) {
      e.preventDefault();
      void select(song.id);
    }
  };
  useEffect(() => {
    const handle = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  async function listen(id: string, file: string) {
    if (preview === id) {
      previewAudio.current?.pause();
      setPreview(null);
      return;
    }
    previewAudio.current?.pause();
    const audio = new Audio(asset(id, file));
    previewAudio.current = audio;
    audio.onended = () => setPreview(null);
    try {
      await audio.play();
      setPreview(id);
    } catch {
      setError("Не удалось воспроизвести мелодию.");
    }
  }
  const lyric =
    song?.lyrics.filter((l) => l.t <= Math.max(0, time)).at(-1)?.text ??
    "Пой на «ла» в удобной тональности";
  return (
    <div className={`shell screen-${screen}`}>
      <header className="topbar">
        <button
          className="brand"
          onClick={() => void requestHome()}
          aria-label="Перепев — главная"
        >
          <Brand />
        </button>
        <nav aria-label="Основная навигация">
          {(
            [
              ["home", "Петь"],
              ["register", "Кабинет"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={
                screen === id ||
                (id === "home" &&
                  ["mic", "sing", "result", "practice"].includes(screen))
                  ? "page"
                  : undefined
              }
              onClick={() => go(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="header-label">Без лишнего шума.</span>
        <button
          className="profile-link"
          aria-label={
            journal.profile ? "Настройки кабинета" : "Войти в кабинет"
          }
          onClick={() => go("register")}
        >
          <span className="avatar">
            {journal.profile?.name.slice(0, 1) || "Я"}
          </span>
          <span>{journal.profile?.name || "Войти"}</span>
        </button>
      </header>
      <main>
        {journal.storageError && (
          <p className="notice" role="status">
            {journal.storageError}
            {journal.pendingSave && (
              <button
                className="secondary"
                disabled={journal.saving}
                onClick={() => void journal.retrySave()}
              >
                Повторить сохранение
              </button>
            )}
          </p>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button className="text-button" onClick={() => setError("")}>
              Закрыть
            </button>
          </div>
        )}
        {screen === "home" && (
          <>
            {ghost && (
              <div className="challenge-banner">
                <div>
                  <span className="eyebrow">ВХОДЯЩИЙ ВЫЗОВ</span>
                  <h3>{ghost.name} оставил свою линию</h3>
                  <p>Спой ту же мелодию в своей тональности.</p>
                </div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void select(ghost.songId)}
                >
                  Принять вызов
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setGhost(null);
                    history.replaceState(
                      null,
                      "",
                      location.pathname + location.search,
                    );
                  }}
                >
                  Без дуэли
                </button>
              </div>
            )}
            <Catalog
              songs={catalog}
              name={name}
              setName={setName}
              busy={busy}
              select={(id) => void select(id)}
              registered={!!journal.profile}
              onResume={
                result && recording.current ? () => go("result") : undefined
              }
              preview={preview}
              listen={(id, file) => void listen(id, file)}
            />
          </>
        )}
        {screen === "register" && (
          <ProfileScreen journal={journal} songs={catalog} onGuest={home} />
        )}
        {screen === "practice" && song && practiceMoment && backing.current && (
          <Practice
            song={song}
            moment={practiceMoment}
            backing={backing.current}
            deviceId={inputs.selected}
            onBack={() => go("result")}
            onWhole={() => void select(song.id)}
          />
        )}
        {screen === "mic" && song && (
          <section className="focus-screen">
            <button className="back" onClick={home}>
              ← Выбрать другую песню
            </button>
            <div className="setup-steps">
              <span>✓ Песня</span>
              <b>2 Микрофон</b>
              <span>3 Спеть</span>
              <span>4 Результат</span>
            </div>
            <div className="setup-layout">
              <div className="setup-copy">
                <h1 className="screen-title">Сначала — звук.</h1>
                <p className="lead">
                  {song.title}, {song.duration_s} секунд
                </p>
                {!ready &&
                  catalog.find((item) => item.id === song.id)?.preview && (
                    <button
                      className="secondary setup-preview"
                      onClick={() => {
                        const file = catalog.find(
                          (item) => item.id === song.id,
                        )?.preview;
                        if (file) void listen(song.id, file);
                      }}
                    >
                      {preview === song.id
                        ? "Остановить эталон"
                        : "Послушать мелодию"}
                    </button>
                  )}
                {ghostResult && (
                  <p className="ghost-label">
                    Против призрака: {ghost?.name} ·{" "}
                    {Math.round(ghostResult.score)} баллов
                  </p>
                )}
                <div className="setup-tips">
                  <article>
                    <span aria-hidden="true">◉</span>
                    <div>
                      <h3>Лучше в наушниках</h3>
                      <p>
                        Так микрофон услышит голос,
                        <br />а не музыку из динамиков.
                      </p>
                    </div>
                  </article>
                  <article>
                    <span aria-hidden="true">◌</span>
                    <div>
                      <h3>Пой обычным голосом</h3>
                      <p>
                        Важно, чтобы индикатор
                        <br />
                        спокойно двигался.
                      </p>
                    </div>
                  </article>
                  <article>
                    <span aria-hidden="true">◇</span>
                    <p>
                      Запись начнётся только
                      <br />
                      после нажатия «Начать пение».
                    </p>
                  </article>
                </div>
              </div>
              <div className="setup-right">
                <div className="mic-panel">
                  <div className="mic-input">
                    <label className="device-field">
                      Устройство ввода
                      <select
                        value={inputs.selected}
                        disabled={busy}
                        aria-label="Устройство ввода"
                        onChange={(e) => {
                          const id = e.target.value;
                          inputs.choose(id);
                          if (ready) void enableMic(id);
                        }}
                      >
                        <option value="">
                          Системный микрофон по умолчанию
                        </option>
                        {inputs.selected &&
                          !inputs.devices.some(
                            (d) => d.deviceId === inputs.selected,
                          ) && (
                            <option value={inputs.selected}>
                              Сохранённый микрофон · подключи или смени вход
                            </option>
                          )}
                        {inputs.devices.map((device, i) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label ||
                              `Микрофон ${i + 1} · название после разрешения`}
                          </option>
                        ))}
                      </select>
                    </label>
                    {inputs.listError && (
                      <p className="fine" role="status">
                        {inputs.listError}
                      </p>
                    )}
                  </div>
                  <div className="mic-level">
                    <span className="fine">Уровень голоса</span>{" "}
                    <div
                      className="level"
                      role="meter"
                      aria-label="Уровень микрофона"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(
                        100,
                        Math.round((live.rms ?? 0) * 600),
                      )}
                    >
                      <div
                        style={{
                          width: `${ready ? Math.min(100, (live.rms ?? 0) * 600) : 0}%`,
                        }}
                      />
                    </div>
                    <p className="mic-status">
                      {!ready
                        ? "Разрешите доступ, чтобы проверить сигнал."
                        : live.midi !== null
                          ? "Голос слышен. Можно начинать."
                          : (live.rms ?? 0) > 0.01
                            ? "Звук есть. Спой протяжную ноту, чтобы появилась линия."
                            : "Ничего не слышно. Проверьте, что выбран нужный микрофон, и попробуйте спеть громче."}
                    </p>
                  </div>
                  <div className="mic-start">
                    {" "}
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => (ready ? start() : void enableMic())}
                    >
                      {busy
                        ? "Подключаем…"
                        : ready
                          ? "Начать пение"
                          : "Включить микрофон"}
                    </button>
                  </div>
                  <MicTrace live={live} ready={ready} />
                  <p className="headphone">
                    Советуем надеть наушники.
                    <br />
                    <span>
                      У ноутбука динамик и микрофон рядом. Без наушников музыка
                      попадёт в запись и исказит оценку.
                    </span>
                  </p>
                </div>
                <p className="keyboard-hint">
                  <kbd>Enter</kbd> подтвердить <kbd>Пробел</kbd> начать{" "}
                  <kbd>Esc</kbd> к мелодиям
                </p>
                <p className="privacy">
                  Никаких загрузок: голос обрабатывается только в этой вкладке.
                </p>
              </div>
            </div>
          </section>
        )}
        {screen === "sing" && song && (
          <section className="sing-screen">
            <div className="section-top">
              <div>
                <div className="sing-title">
                  <img src={cover(song.id)} alt="" />
                  <h2>{song.title}</h2>
                </div>
              </div>
              <div className="sing-actions">
                <span className="keyboard-hint">
                  <kbd>Пробел</kbd> пауза / продолжить <kbd>Esc</kbd> выход
                </span>
                <button
                  className="secondary"
                  onClick={() => void setTransportPause(!paused)}
                >
                  {paused ? "Продолжить" : "Пауза"}
                </button>
                <button
                  className="secondary"
                  onClick={() => void requestHome()}
                >
                  Выйти
                </button>
              </div>
            </div>
            <div className="sing-status">
              {time < 0 ? "Приготовься" : "Записываем только на устройстве"}
              <span>
                {Math.max(0, Math.floor(time))} / {song.duration_s} сек
              </span>
            </div>
            <div className="lyric-stack">
              <p>
                {time < 0
                  ? "Приготовься к вступлению"
                  : "Твоя тональность. Твоя версия."}
              </p>{" "}
              <h3 className="lyrics">
                {time < 0
                  ? "Вдохни. Выбери удобную высоту."
                  : lyric.replaceAll(" · ", " ")}
              </h3>
              <p>Слушай музыку. Линия — только подсказка.</p>
            </div>
            <div className="roll-wrap">
              <PianoRoll
                song={song}
                frames={frames.current}
                time={Math.max(0, time)}
                ghost={ghostFrames}
                ghostShift={ghostResult?.registerShift ?? 0}
              />
              {paused ? (
                <div className="pause-overlay">
                  <b>Пауза</b>
                  <span>
                    <kbd>Пробел</kbd> — продолжить с той же секунды
                  </span>
                </div>
              ) : (
                time < 0 && (
                  <div className="countdown" aria-live="polite">
                    {Math.ceil(-time)}
                  </div>
                )
              )}
            </div>
            <div className="legend">
              <span>━ Эталон</span>
              <span className="echo">━ Твой голос</span>
              {ghostResult && (
                <span className="ghost-label">┄ {ghost?.name}</span>
              )}
            </div>
            {time > 3 && live.midi === null && (
              <p role="status">Голос не слышен. Пой чуть ближе к микрофону.</p>
            )}
            {busy && <p role="status">Считаем интервалы и ритм…</p>}
          </section>
        )}
        {screen === "result" && result && song && (
          <section
            className={`result-screen ${ghostResult && resultTab === "duel" ? "duel-view" : ""}`}
          >
            <div className="section-top">
              <div>
                <h2>
                  {result.axes.coverage < 0.3
                    ? "Попробуй спеть громче"
                    : result.score >= 85
                      ? "Есть попадание."
                      : "Есть попадание."}
                </h2>
                <p>
                  {name || "Твой голос"}: {song.title}
                </p>
              </div>
              <button
                className="secondary"
                onClick={() => void select(song.id)}
              >
                Спеть ещё раз <kbd>R</kbd>
              </button>
            </div>
            {ghostResult && (
              <div className="result-tabs" aria-label="Вид результата">
                <button
                  aria-pressed={resultTab === "review"}
                  onClick={() => setResultTab("review")}
                >
                  Мой разбор
                </button>
                <button
                  aria-pressed={resultTab === "duel"}
                  onClick={() => setResultTab("duel")}
                >
                  Дуэль
                </button>
              </div>
            )}
            <div className="result-grid">
              <div className="score-card">
                <span className="eyebrow">Твой результат</span>
                <div className="big-score">
                  <CountScore value={result.score} />
                  <small>/ 100</small>
                </div>
                <span className="score-caption">
                  {result.axes.coverage < 0.3
                    ? "Слишком мало голоса для оценки"
                    : "За мелодию. Не за чужую тональность."}
                </span>
                <div className="shift-pill">
                  <span>Тональный сдвиг</span>
                  <strong>
                    {signed(result.shift)} <small>полутонов</small>
                  </strong>
                  <span className="shift-no-penalty">Штрафа нет</span>
                </div>
              </div>
              <div className="axes-card">
                {Object.entries(axisNames).map(([key, label]) => (
                  <div className="axis" key={key}>
                    <div>
                      <span>{label}</span>
                      <b>
                        {Math.round(
                          result.axes[key as keyof typeof axisNames] * 100,
                        )}
                        <small> / 100</small>
                      </b>
                    </div>
                    <div className="axis-track">
                      <i
                        style={{
                          width: `${result.axes[key as keyof typeof axisNames] * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <section className="timeline-panel">
              <div className="section-top">
                <h3>Вся попытка на одной линии</h3>
                <span className="fine">
                  0:00 — 0:{Math.round(song.duration_s)}
                </span>
              </div>
              <ResultTrace
                song={song}
                frames={frames.current}
                result={result}
                ideal={idealView}
              />
              <div className="legend">
                <span className="echo">
                  ━ {idealView ? "Идеальная высота" : "Как пел"}
                </span>
                <span>Серый — ориентир</span>
                <span className="error-key">┄ Ошибка</span>
                <span>Разрыв — пропуск</span>
              </div>
            </section>
            {recording.current && backing.current && (
              <Review
                song={song}
                frames={frames.current}
                recording={recording.current}
                backing={backing.current}
                result={result}
                onIdealChange={setIdealView}
                onPractice={(m) => {
                  setPracticeMoment(m);
                  go("practice");
                }}
              />
            )}
            <Duel
              song={song}
              frames={frames.current}
              name={name}
              ghost={ghostResult ? ghost : null}
              displayBattle={resultTab === "duel"}
              ideal={idealView}
            />
          </section>
        )}
      </main>
      {exitOpen && <ExitDialog onConfirm={confirmExit} onCancel={cancelExit} />}
      <footer>
        <span>ПЕРЕПЕВ / КАРАОКЕ-БАТТЛ</span>
        <span>Пой по-своему. Попадай точнее.</span>
      </footer>
    </div>
  );
}
