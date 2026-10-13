import { useEffect, useRef, useState } from "react";
import type { Song, PitchFrame } from "../types";
import type { Moment } from "../scoring";
import { Capture } from "../audio/capture";
import { PianoRoll } from "./PianoRoll";
export function Practice({
  song,
  moment,
  backing,
  deviceId,
  onBack,
  onWhole,
}: {
  song: Song;
  moment: Moment;
  backing: AudioBuffer;
  deviceId: string;
  onBack: () => void;
  onWhole: () => void;
}) {
  const [time, setTime] = useState(moment.start_s),
    [running, setRunning] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mic = useRef<Capture | null>(null),
    source = useRef<AudioBufferSourceNode | null>(null),
    raf = useRef(0),
    points = useRef<PitchFrame[]>([]),
    ticket = useRef(0);
  const from = Math.max(0, moment.start_s - 0.3),
    to = Math.min(song.duration_s, moment.end_s + 0.3);
  function stop() {
    ticket.current++;
    cancelAnimationFrame(raf.current);
    try {
      source.current?.stop();
    } catch {
      /* already ended */
    }
    source.current = null;
    mic.current?.stop();
    mic.current = null;
    setRunning(false);
    setBusy(false);
  }
  useEffect(
    () => () => {
      ticket.current++;
      cancelAnimationFrame(raf.current);
      try {
        source.current?.stop();
      } catch {
        /* already ended */
      }
      mic.current?.stop();
    },
    [],
  );
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        stop();
        setError("Репетиция остановлена: вкладка ушла в фон.");
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  async function play() {
    stop();
    const id = ++ticket.current;
    setBusy(true);
    setError("");
    points.current = [];
    try {
      const input = await Capture.open(() => {}, deviceId);
      if (id !== ticket.current) {
        input.stop();
        return;
      }
      mic.current = input;
      const at = input.ctx.currentTime + 3;
      input.begin(at, to - from);
      const audio = input.ctx.createBufferSource();
      audio.buffer = backing;
      audio.connect(input.ctx.destination);
      source.current = audio;
      audio.start(at, from, to - from);
      setRunning(true);
      setBusy(false);
      const tick = () => {
        const elapsed = input.ctx.currentTime - at;
        points.current = input.frames.map((f) => ({ ...f, t: f.t + from }));
        setTime(from + elapsed);
        if (elapsed < to - from) raf.current = requestAnimationFrame(tick);
        else stop();
      };
      tick();
    } catch (e) {
      if (id === ticket.current) {
        setError(
          `Не удалось начать репетицию. Проверь микрофон. ${(e as Error).message}`,
        );
        stop();
      }
    }
  }
  const lyric =
    song.lyrics.filter((l) => l.t <= Math.max(from, time)).at(-1)?.text ||
    "Пой на «ла»";
  return (
    <section className="practice-page">
      <div className="section-top">
        <button className="back" onClick={onBack}>
          ← К разбору
        </button>
        <span className="practice-badge">Репетиция · без оценки</span>
      </div>
      <div className="practice-intro">
        <span className="eyebrow">
          {song.title} / ФРАЗА {moment.phrase}
        </span>
        <h1>Поймай нужный момент.</h1>
        <h2>{lyric.replaceAll(" · ", " ")}</h2>
        <p>Перед началом — три секунды на вдох. Пой в своей тональности.</p>
      </div>
      <div className="roll-wrap">
        <PianoRoll
          song={song}
          frames={points.current}
          time={Math.max(from, time)}
        />
        {running && time < from && (
          <div className="countdown">{Math.ceil(from - time)}</div>
        )}
      </div>
      <div className="practice-controls">
        <span>
          {from.toFixed(1)}–{to.toFixed(1)} с / обычный темп
        </span>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => (running ? stop() : void play())}
        >
          {busy ? "Подключаем…" : running ? "Остановить" : "Повторить фрагмент"}
        </button>
        <button className="primary" onClick={onWhole}>
          Спеть целиком
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <p className="fine">
        Репетиция не меняет балл и не сохраняет запись. Для нового результата
        спой весь фрагмент.
      </p>
    </section>
  );
}
