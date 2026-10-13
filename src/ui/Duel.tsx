import { ResultTrace } from "./ResultTrace";
import { useMemo, useState } from "react";
import type { PitchFrame, Song } from "../types";
import {
  canonicalCurve,
  encodeChallenge,
  type Challenge,
} from "../challenge/codec";
import { scorePerformance } from "../scoring";
const labels = {
  intervals: "Интервалы",
  rhythm: "Ритм",
  stability: "Стабильность",
  coverage: "Покрытие",
};
export function Duel({
  song,
  frames,
  name,
  ghost,
  displayBattle = true,
  ideal = false,
}: {
  song: Song;
  frames: PitchFrame[];
  name: string;
  ghost: Challenge | null;
  displayBattle?: boolean;
  ideal?: boolean;
}) {
  const yours = useMemo(
    () => scorePerformance(canonicalCurve(frames, song.duration_s), song),
    [frames, song],
  );
  const rival = useMemo(
    () => (ghost ? scorePerformance(ghost.curve, song) : null),
    [ghost, song],
  );
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  function getLink() {
    const fragment = encodeChallenge({
      v: 1,
      songId: song.id,
      name: name || "Соперник",
      shift: yours.shift,
      score: yours.score,
      curve: canonicalCurve(frames, song.duration_s),
    });
    return `${location.origin}${location.pathname}${location.search}${fragment}`;
  }
  async function copy() {
    try {
      const url = getLink();
      setLink(url);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setMessage("Ссылка скопирована");
      } else setMessage("Скопируй ссылку из поля ниже.");
    } catch {
      setMessage("Автокопирование недоступно. Выдели ссылку в поле ниже.");
    }
  }
  return (
    <section className="duel-panel">
      {rival && ghost && displayBattle && (
        <div className="battle-summary">
          <div className="eyebrow">Дуэль завершена</div>
          <h2
            className={
              yours.score >= rival.score ? "winner-self" : "winner-ghost"
            }
          >
            {Math.round(yours.score * 10) === Math.round(rival.score * 10)
              ? "Ничья"
              : yours.score > rival.score
                ? "Твоя победа"
                : `${ghost.name} впереди`}
          </h2>
          <div className="battle-grid">
            {[
              { name: name || "Ты", result: yours },
              { name: ghost.name, result: rival },
            ].map((player, index) => (
              <div className={`battle-player player-${index}`} key={index}>
                <span className="fine">
                  {index ? "Призрак соперника" : "Твоя попытка"}
                </span>
                <h3>{player.name}</h3>
                <b className="battle-score">
                  {player.result.score.toFixed(1)}
                  <small>/ 100</small>
                </b>
                {Object.entries(labels).map(([key, label]) => (
                  <div className="battle-axis" key={key}>
                    <span>{label}</span>
                    <b>
                      {Math.round(
                        player.result.axes[key as keyof typeof labels] * 100,
                      )}
                    </b>
                    <div className="battle-axis-track">
                      <i
                        style={{
                          width: `${player.result.axes[key as keyof typeof labels] * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <div className="battle-timeline">
              <h3>Два голоса, одна мелодия</h3>
              <ResultTrace
                song={song}
                frames={canonicalCurve(frames, song.duration_s)}
                result={yours}
                rival={ghost.curve}
                rivalResult={rival}
                ideal={ideal}
              />
              <div className="legend">
                <span className="echo">━ Ты</span>
                <span className="ghost-label">┄ {ghost.name}</span>
              </div>
              <div className="timeline-scale">
                <span>0:00</span>
                <span>{song.duration_s} сек</span>
              </div>
              <p className="fine">
                Обе попытки оценены одинаково. Линии совмещены по тональности;
                пунктир показывает соперника.
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="share-actions">
        <button className="primary" onClick={() => void copy()}>
          Скопировать ссылку-вызов
        </button>
      </div>
      {message && (
        <p role="status" className="fine">
          {message}
        </p>
      )}
      {link && (
        <label className="share-link">
          Ссылка-вызов
          <input
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            aria-label="Ссылка-вызов"
          />
        </label>
      )}
      <p className="challenge-score fine">
        Вызов: {Math.round(yours.score)} / 100 после сжатия. Незначительное
        отличие от разбора возможно из-за шага 50 мс.
      </p>
    </section>
  );
}
