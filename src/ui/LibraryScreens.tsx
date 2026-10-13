import { useMemo, useState } from "react";
import type { SongInfo, Song } from "../types";
import type { Attempt } from "./profile";
import type { Challenge } from "../challenge/codec";
import { cover } from "./Brand";
export function Catalog({
  songs,
  name,
  setName,
  select,
  preview,
  listen,
  busy,
}: {
  songs: SongInfo[];
  name: string;
  setName: (n: string) => void;
  select: (id: string) => void;
  preview: string | null;
  listen: (id: string, file: string) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("Все");
  const filtered = songs.filter(
    (s) =>
      (s.title + " " + s.artist)
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (filter !== "Легко начать" || s.id === "ode") &&
      (filter !== "До 30 секунд" || s.duration_s <= 30),
  );
  const featured = songs[0];
  return (
    <>
      <section className="catalog-hero">
        <div>
          <span className="eyebrow">ТВОЯ МАЛЕНЬКАЯ СЦЕНА</span>
          <h1>
            Твой голос.
            <br />
            Твоя версия.
          </h1>
          <p className="lead">
            Спой короткий фрагмент в своей тональности.
            <br />
            Узнай, где совпали интервалы, и попробуй точнее.
          </p>
          <label className="name-field">
            Твоё имя
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="Например, Саша"
              autoComplete="nickname"
            />
          </label>
        </div>
        {featured && (
          <aside className="featured">
            <img src={cover(featured.id)} alt="" />
            <div>
              <span className="eyebrow">НАЧНИ С МЕЛОДИИ</span>
              <h2>{featured.title}</h2>
              <p>{featured.duration_s} секунд в своей тональности</p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => select(featured.id)}
              >
                Попробовать <span aria-hidden="true">→</span>
              </button>
            </div>
          </aside>
        )}
      </section>
      <section className="song-section">
        <div className="section-top">
          <h2>
            Выбери фрагмент{" "}
            <span className="catalog-count">
              {String(songs.length).padStart(2, "0")}
            </span>
          </h2>
          <label className="search-field">
            <span className="sr-only">Песня или исполнитель</span>
            <input
              type="search"
              placeholder="Песня или исполнитель"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="catalog-toolbar">
          <div className="filters">
            {["Все", "Легко начать", "До 30 секунд"].map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="fine">Подготовленные фрагменты</span>
        </div>
        <div className="song-grid">
          {filtered.map((s) => (
            <article className="song-card" key={s.id}>
              <img src={cover(s.id)} alt="" />
              <div className="song-body">
                <h3>{s.title}</h3>
                <p>{s.artist.replaceAll(" · ", ", ")}</p>
                <span className="fine">
                  {s.id === "ode" ? "Легко" : "Попробуй скачки"} ·{" "}
                  {s.duration_s} с
                </span>
                <div className="song-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => select(s.id)}
                  >
                    Спеть <span aria-hidden="true">→</span>
                  </button>
                  {s.preview && (
                    <button
                      className="text-button muted"
                      aria-label={`${preview === s.id ? "Остановить" : "Послушать"} ${s.title}`}
                      onClick={() => listen(s.id, s.preview!)}
                    >
                      {preview === s.id ? "Стоп" : "Послушать"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
        {!songs.length ? (
          <p role="status">Загружаем мелодии…</p>
        ) : !filtered.length ? (
          <div className="empty-state">
            <h3>Такой мелодии пока нет</h3>
            <p>Попробуй другое название или сбрось фильтры.</p>
            <button
              className="secondary"
              onClick={() => {
                setQuery("");
                setFilter("Все");
              }}
            >
              Сбросить поиск
            </button>
          </div>
        ) : null}
        <p className="license-note">
          Два разрешённых демо-фрагмента. Собственный синтез, без чужих
          фонограмм.
        </p>
      </section>
    </>
  );
}
export function SongDetail({
  song,
  info,
  preview,
  listen,
  onStart,
  onBack,
  best,
}: {
  song: Song;
  info?: SongInfo;
  preview: string | null;
  listen: () => void;
  onStart: () => void;
  onBack: () => void;
  best?: number;
}) {
  return (
    <section className="detail-page">
      <button className="back" onClick={onBack}>
        ← К песням
      </button>
      <div className="detail-grid">
        <aside>
          <img
            className="detail-art"
            src={cover(song.id)}
            alt="Графическая обложка фрагмента"
          />
          <div className="personal-best">
            <span className="eyebrow">ТВОЙ ЛУЧШИЙ ДУБЛЬ</span>
            {best === undefined ? (
              <p>Первый дубль ещё впереди.</p>
            ) : (
              <strong>
                {Math.round(best)} <small>/ 100</small>
              </strong>
            )}
          </div>
        </aside>
        <div className="detail-copy">
          <span className="eyebrow">ДЕМО-КАТАЛОГ</span>
          <h1>{song.title}</h1>
          <p className="lead">{song.artist.replaceAll(" · ", ", ")}</p>
          <div className="tags">
            <span>
              {song.id === "ode" ? "Легко начать" : "Попробуй скачки"}
            </span>
            <span>{song.duration_s} секунд</span>
            <span>Своя тональность</span>
          </div>
          <h3>Одна мелодия. Твоя версия.</h3>
          <p>00:00 — 00:{song.duration_s} / подготовленный фрагмент</p>
          <div className="reference-player">
            <button
              className="play-circle"
              disabled={!info?.preview}
              aria-label={
                preview === song.id ? "Остановить эталон" : "Послушать эталон"
              }
              onClick={listen}
            >
              {preview === song.id ? "Ⅱ" : "▷"}
            </button>
            <svg viewBox="0 0 500 60" aria-label="Контур эталона" role="img">
              <path
                d={song.f0_midi
                  .filter((_, i) => i % 10 === 0)
                  .map((m, i) =>
                    m === null
                      ? ""
                      : `${i === 0 || song.f0_midi[(i - 1) * 10] === null ? "M" : "L"}${(i / (song.f0_midi.length / 10)) * 500},${50 - ((m - 55) % 24) * 2}`,
                  )
                  .join(" ")}
              />
            </svg>
            <span>{song.duration_s} с</span>
          </div>
          <p className="fine">
            Послушай эталон: так легче почувствовать вступление.
          </p>
          <h3>Как споём?</h3>
          <p>Сначала запиши свою попытку. Потом отправь другу ссылку-вызов.</p>
          <button className="primary" onClick={onStart}>
            Проверить микрофон <span aria-hidden="true">→</span>
          </button>
          <p className="fine">
            Оцениваем интервалы и ритм. За перенос тональности штрафа нет.
          </p>
        </div>
      </div>
    </section>
  );
}
export function DuelLobby({
  ghost,
  songs,
  onSelect,
  onCatalog,
  onResult,
  hasResult,
}: {
  ghost: Challenge | null;
  songs: SongInfo[];
  onSelect: (id: string) => void;
  onCatalog: () => void;
  onResult: () => void;
  hasResult: boolean;
}) {
  const info = songs.find((s) => s.id === ghost?.songId);
  return (
    <section className="lobby-page">
      <span className="eyebrow">НА ОДНОЙ ВОЛНЕ. ПО РАЗНЫЕ СТОРОНЫ.</span>
      <h1>Споём на спор?</h1>
      <p className="lead">
        Одна мелодия. Два голоса. Отправь ссылку другу —<br />
        петь одновременно не обязательно.
      </p>
      <div className="lobby-grid">
        <div>
          <div className="lobby-fragment">
            <img src={cover(info?.id || "ode")} alt="" />
            <div>
              <span className="eyebrow">ФРАГМЕНТ ДУЭЛИ</span>
              <h2>{info?.title || "Выбери свою мелодию"}</h2>
              <p>
                {info
                  ? `${info.duration_s} секунд в удобной тональности`
                  : "Сначала спой — затем брось вызов."}
              </p>
              <button className="text-button" onClick={onCatalog}>
                К каталогу →
              </button>
            </div>
          </div>
          <h3>Чтобы было честно</h3>
          <ol className="duel-rules">
            <li>Один фрагмент и одна формула оценки.</li>
            <li>Можно петь в своей тональности.</li>
            <li>Друг увидит линию голоса, но не услышит запись.</li>
          </ol>
        </div>
        <div className="invitation-card">
          <span className="eyebrow">
            {ghost ? "ВХОДЯЩИЙ ВЫЗОВ" : "ДУЭЛЬ ПО ССЫЛКЕ"}
          </span>
          <h2>
            {ghost
              ? `${ghost.name} ждёт твою попытку`
              : "Начни со своего дубля"}
          </h2>
          <div className="duel-people">
            <div>
              <span className="avatar">Я</span>
              <b>Ты</b>
              <small>Твоя тональность</small>
            </div>
            <span className="versus">↔</span>
            <div>
              <span className="avatar">{ghost?.name.slice(0, 1) || "?"}</span>
              <b>{ghost?.name || "Твой друг"}</b>
              <small>{ghost ? "Линия уже записана" : "По приглашению"}</small>
            </div>
          </div>
          <p>
            {ghost
              ? "Вызов открыт. Спой тот же фрагмент — сравним оба результата."
              : "После полной попытки появится кнопка «Скопировать ссылку-вызов»."}
          </p>
          <button
            className="primary"
            onClick={() =>
              ghost
                ? onSelect(ghost.songId)
                : hasResult
                  ? onResult()
                  : onCatalog()
            }
          >
            {ghost
              ? "Принять вызов"
              : hasResult
                ? "Поделиться последней попыткой"
                : "Выбрать песню"}
          </button>
          <p className="fine">
            Без комнаты ожидания и загрузки аудио на сервер.
          </p>
        </div>
      </div>
    </section>
  );
}
const names = {
  intervals: "Интервалы",
  rhythm: "Ритм",
  stability: "Стабильность",
  coverage: "Покрытие",
};
export function HistoryScreen({
  attempts,
  songs,
  mode,
  onSing,
}: {
  attempts: Attempt[];
  songs: SongInfo[];
  mode: "progress" | "ranking";
  onSing: () => void;
}) {
  const [songId, setSongId] = useState(songs[0]?.id || "ode"),
    [open, setOpen] = useState<string | null>(null);
  const selected = attempts.filter((a) => a.songId === songId);
  const rows = useMemo(() => {
    if (mode === "progress") return selected;
    const best = new Map<string, Attempt>();
    for (const a of selected) {
      const key = a.owner === "guest" ? a.name : a.owner;
      if (!best.has(key) || best.get(key)!.score < a.score) best.set(key, a);
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }, [attempts, songId, mode]);
  const chart = [...selected].reverse().slice(-10);
  return (
    <section className="history-page">
      <div className="section-top">
        <div>
          <span className="eyebrow">
            {mode === "progress"
              ? "ТВОЙ ГОЛОС В ДИНАМИКЕ"
              : "РЕЙТИНГ ОДНОЙ МЕЛОДИИ"}
          </span>
          <h1>
            {mode === "progress"
              ? "Слышно, как растёшь."
              : "Не громче. Точнее."}
          </h1>
          <p className="lead">
            {mode === "progress"
              ? "Твои полные попытки на этом устройстве."
              : "Лучшие результаты профилей в этом браузере. Онлайн-рейтинга нет."}
          </p>
        </div>
        <label className="field">
          Фрагмент
          <select
            value={songId}
            onChange={(e) => {
              setSongId(e.target.value);
              setOpen(null);
            }}
          >
            {songs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows.length ? (
        <div className="empty-state">
          <h2>Пока нет результатов</h2>
          <p>Выбери песню и спой. Здесь появится твой первый полный дубль.</p>
          <button className="primary" onClick={onSing}>
            Выбрать песню
          </button>
        </div>
      ) : (
        <>
          {mode === "progress" && (
            <div className="progress-chart">
              <span className="eyebrow">ОЦЕНКА КАЖДОГО ДУБЛЯ</span>
              <svg
                viewBox="0 0 1000 150"
                role="img"
                aria-label="Баллы последних десяти попыток"
              >
                <path
                  d={chart
                    .map(
                      (a, i) =>
                        `${i ? "L" : "M"}${40 + (i / Math.max(1, chart.length - 1)) * 920},${125 - a.score}`,
                    )
                    .join(" ")}
                />
                {chart.map((a, i) => (
                  <g key={a.id}>
                    <circle
                      cx={40 + (i / Math.max(1, chart.length - 1)) * 920}
                      cy={125 - a.score}
                      r="4"
                    />
                    <text
                      x={40 + (i / Math.max(1, chart.length - 1)) * 920}
                      y={110 - a.score}
                      textAnchor="middle"
                    >
                      {Math.round(a.score)}
                    </text>
                    <text
                      x={40 + (i / Math.max(1, chart.length - 1)) * 920}
                      y="146"
                      textAnchor="middle"
                    >
                      Дубль {i + 1}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          )}
          <div className="history-table">
            <div className="history-row table-head">
              <span>
                {mode === "progress" ? "Попытка" : "Место / участник"}
              </span>
              <span>Интервалы</span>
              <span>Ритм</span>
              <span>Балл</span>
              <span />
            </div>
            {rows.map((a, i) => (
              <div key={a.id}>
                <div className="history-row">
                  <span>
                    <b>
                      {mode === "progress"
                        ? `Дубль ${selected.length - i}`
                        : `${i + 1}. ${a.name}`}
                    </b>
                    <small>{new Date(a.at).toLocaleDateString("ru-RU")}</small>
                  </span>
                  <span>{Math.round(a.axes.intervals * 100)}</span>
                  <span>{Math.round(a.axes.rhythm * 100)}</span>
                  <strong>{Math.round(a.score)}</strong>
                  <button
                    className="text-button"
                    aria-expanded={open === a.id}
                    onClick={() => setOpen(open === a.id ? null : a.id)}
                  >
                    {open === a.id ? "Свернуть" : "Разобрать"}
                  </button>
                </div>
                {open === a.id && (
                  <div className="saved-breakdown">
                    <div>
                      {Object.entries(names).map(([key, label]) => (
                        <span key={key}>
                          {label}:{" "}
                          {Math.round(a.axes[key as keyof typeof names] * 100)}
                        </span>
                      ))}
                    </div>
                    <p>
                      Тональный сдвиг: {a.shift > 0 ? "+" : ""}
                      {Math.round(a.shift * 10) / 10} полутонов. Штрафа нет.
                    </p>
                    {a.moments.map((m, i) => (
                      <p key={i}>{m.text}</p>
                    ))}
                    <p className="fine">
                      Это сохранённый разбор. Аудиозаписи в истории нет.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="fine">
            Сохраняем до 50 последних результатов. Интервалы 45%, ритм 25%,
            стабильность 15%, покрытие 15%.
          </p>
        </>
      )}
    </section>
  );
}
