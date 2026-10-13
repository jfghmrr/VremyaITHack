import { useEffect, useRef, useState } from "react";
import type { Song, PitchFrame, Recording } from "../types";
import type { ScoreResult } from "../scoring";
import { Playback, type IdealEngine } from "../audio/playback";
export function Review({
  song,
  frames,
  recording,
  backing,
  result,
  onIdealChange,
  onPractice,
}: {
  song: Song;
  frames: PitchFrame[];
  recording: Recording;
  backing: AudioBuffer;
  result: ScoreResult;
  onIdealChange: (ideal: boolean) => void;
  onPractice: (moment: ScoreResult["moments"][number]) => void;
}) {
  const [engine, setEngine] = useState<IdealEngine>("synth");
  const [ideal, setIdeal] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fragment, setFragment] = useState<number | null>(null);
  const playback = useRef<Playback | null>(null);
  const ticket = useRef(0);
  function stop() {
    setBusy(false);
    ticket.current++;
    playback.current?.stop();
    playback.current = null;
    setPlaying(false);
    setFragment(null);
  }
  useEffect(
    () => () => {
      ticket.current++;
      playback.current?.stop();
    },
    [],
  );
  async function play(
    from = 0,
    to = song.duration_s,
    part: number | null = null,
  ) {
    stop();
    if (part !== null) {
      setIdeal(false);
      onIdealChange(false);
    }
    const id = ++ticket.current;
    setBusy(true);
    setError("");
    try {
      const p = await Playback.create(
        recording,
        backing,
        song,
        frames,
        result,
        engine,
        part === null ? ideal : false,
        from,
        to,
        () => {
          setPlaying(false);
          setFragment(null);
        },
      );
      if (ticket.current !== id) {
        p.stop();
        return;
      }
      playback.current = p;
      setPlaying(true);
      setFragment(part);
    } catch (e) {
      setError(
        `Не удалось запустить звук: ${(e as Error).message}. Попробуй синтезированный ориентир.`,
      );
    } finally {
      if (ticket.current === id) setBusy(false);
    }
  }
  function toggle(value: boolean) {
    setIdeal(value);
    onIdealChange(value);
    if (fragment !== null) {
      stop();
    } else playback.current?.setIdeal(value);
  }
  return (
    <>
      <section className="moments-panel">
        <div className="section-top">
          <div>
            <h3>
              {result.moments.length
                ? result.moments.length === 1
                  ? "1 момент, где ушли баллы"
                  : `${result.moments.length} момента, где ушли баллы`
                : "Заметных потерь не найдено"}
            </h3>
          </div>
        </div>
        {result.constantTone && (
          <p className="notice">
            Почти одна нота всю попытку. Повтори движение мелодии вверх и вниз.
          </p>
        )}
        {result.moments.map((m, i) => (
          <article className="moment" key={m.start_s}>
            <div>
              <span className="moment-time">
                {m.start_s.toFixed(1)}–{m.end_s.toFixed(1)} с{" "}
                <span>
                  {m.reason === "missing"
                    ? "Пропуск"
                    : m.reason === "rhythm"
                      ? "Ритм"
                      : "Высота"}
                </span>
              </span>
              <p>
                {m.text.includes("на 0 центов")
                  ? `Во фразе ${m.phrase} высота голоса отклонялась от мелодии. Переслушай этот момент в своей тональности.`
                  : m.text}
              </p>
            </div>
            <div className="moment-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void play(
                    Math.max(0, m.start_s - 0.3),
                    Math.min(song.duration_s, m.end_s + 0.3),
                    i,
                  )
                }
              >
                Переслушать
              </button>
              <button
                className="text-button"
                aria-label="Повторить фрагмент"
                onClick={() => onPractice(m)}
              >
                Повторить
              </button>
            </div>
          </article>
        ))}
      </section>
      <section className="review-panel">
        <div className="ab-controls">
          <button
            className="play-circle"
            disabled={busy}
            aria-label={playing ? "Остановить запись" : "Воспроизвести запись"}
            onClick={() => (playing ? stop() : void play())}
          >
            {busy ? "…" : playing ? "■" : "▷"}
          </button>
          <div className="segmented" aria-label="Версия записи">
            <button aria-pressed={!ideal} onClick={() => toggle(false)}>
              Как пел
            </button>
            <button aria-pressed={ideal} onClick={() => toggle(true)}>
              Идеальный я
            </button>
          </div>
        </div>
        <label className="engine-select">
          Режим «идеального себя»
          <select
            value={engine}
            onChange={(e) => {
              stop();
              setEngine(e.target.value as IdealEngine);
            }}
          >
            <option value="synth">Синтезированный ориентир</option>
            <option value="voice">Мой голос (эксперимент)</option>
          </select>
        </label>
        <p className="fine">
          {engine === "synth"
            ? "В B звучит синтезированный голос в твоей тональности. Это ориентир мелодии, а не твой тембр."
            : "В B звучит обработанная запись. На больших поправках возможны искажения и задержка."}{" "}
          Переключай A/B во время воспроизведения.
        </p>
        {playing && (
          <p className="playing-label" role="status">
            {fragment === null
              ? "Слушаем попытку…"
              : `Переслушиваем момент ${fragment + 1}…`}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
