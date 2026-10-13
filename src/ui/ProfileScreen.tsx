import { useState } from "react";
import type { Credentials, useProfile } from "./profile";
import type { SongInfo } from "../types";
import { HistoryScreen } from "./LibraryScreens";
type Journal = ReturnType<typeof useProfile>;
export function ProfileScreen({
  journal,
  songs,
  onGuest,
}: {
  journal: Journal;
  songs: SongInfo[];
  onGuest: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [tab, setTab] = useState<"history" | "settings">("history");
  const [form, setForm] = useState<Credentials>({
    name: journal.profile?.name || "",
    email: "",
    password: "",
    consent: false,
  });
  const [confirm, setConfirm] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  async function run(action: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
      setSuccess(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (journal.loading)
    return (
      <section className="empty-state" role="status">
        Открываем кабинет…
      </section>
    );
  if (journal.profile)
    return (
      <section className="account-page">
        <div className="account-heading">
          <div>
            <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span>
            <h1>{journal.profile.name}</h1>
            <p>{journal.profile.email}</p>
          </div>
          <button className="primary" onClick={onGuest}>
            Спеть новую попытку
          </button>
        </div>
        <div className="account-tabs">
          <div className="segmented">
            <button
              aria-pressed={tab === "history"}
              onClick={() => {
                setTab("history");
                setError("");
                setSuccess("");
              }}
            >
              Мои результаты
            </button>
            <button
              aria-pressed={tab === "settings"}
              onClick={() => {
                setTab("settings");
                setForm((f) => ({ ...f, name: journal.profile!.name }));
                setError("");
                setSuccess("");
              }}
            >
              Настройки
            </button>
          </div>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void run(() => journal.logout())}
          >
            Выйти
          </button>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {success && (
          <p role="status" className="account-success">
            {success}
          </p>
        )}
        {tab === "history" ? (
          <HistoryScreen
            mode="progress"
            attempts={journal.attempts}
            songs={songs}
            onSing={onGuest}
            remote
          />
        ) : (
          <div className="account-settings">
            <form
              className="registration-card"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => journal.updateName(form.name), "Имя обновлено.");
              }}
            >
              <h2>Как тебя представить</h2>
              <label className="field">
                Имя
                <input
                  required
                  minLength={2}
                  maxLength={32}
                  autoComplete="nickname"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <p className="fine">
                Имя видно в ссылке-вызове. Почта доступна только тебе.
              </p>
              <button className="primary" disabled={busy}>
                Сохранить имя
              </button>
            </form>
            <form
              className="registration-card"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await journal.changePassword(currentPassword, newPassword);
                  setCurrentPassword("");
                  setNewPassword("");
                }, "Пароль изменён. Другие сеансы завершены.");
              }}
            >
              <h2>Сменить пароль</h2>
              <label className="field">
                Текущий пароль
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </label>
              <label className="field">
                Новый пароль
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                Изменить пароль
              </button>
            </form>
          </div>
        )}
      </section>
    );
  return (
    <section className="registration-page auth-page">
      <div className="registration-story">
        <span className="eyebrow">ВСЕ ПОПЫТКИ В ОДНОМ МЕСТЕ</span>
        <h1>
          Твой голос.
          <br />
          Твой прогресс.
        </h1>
        <p className="lead">
          Войди, чтобы сохранять результаты
          <br />и возвращаться к разбору.
        </p>
        <ol className="account-benefits">
          <li>История дублей и личные рекорды</li>
          <li>Один кабинет в разных браузерах этого сайта</li>
          <li>Запись голоса остаётся только у тебя</li>
        </ol>
        <button className="text-button" onClick={onGuest}>
          Сначала попробовать без входа →
        </button>
        <p className="fine">
          Почта используется для входа. Подтверждение почты и восстановление
          пароля пока не подключены.
        </p>
      </div>
      <form
        className="registration-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "register" && form.password !== confirm) {
            setError("Пароли не совпадают.");
            return;
          }
          void run(async () => {
            await journal.authenticate(mode, form);
            setForm({ ...form, password: "" });
            setConfirm("");
          });
        }}
      >
        <div className="segmented">
          <button
            type="button"
            aria-pressed={mode === "login"}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Вход
          </button>
          <button
            type="button"
            aria-pressed={mode === "register"}
            onClick={() => {
              setMode("register");
              setError("");
            }}
          >
            Регистрация
          </button>
        </div>
        <h2>{mode === "login" ? "С возвращением" : "Создать кабинет"}</h2>
        {mode === "register" && (
          <label className="field">
            Имя
            <input
              required
              minLength={2}
              maxLength={32}
              autoComplete="nickname"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
        )}
        <label className="field">
          Почта
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="field">
          Пароль
          <input
            type="password"
            autoComplete={
              mode === "register" ? "new-password" : "current-password"
            }
            required
            minLength={12}
            maxLength={128}
            aria-label="Пароль"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <span className="fine">
            От 12 символов. Можно использовать длинную фразу.
          </span>
        </label>
        {mode === "register" && (
          <>
            <label className="field">
              Повтори пароль
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                required
                checked={form.consent}
                onChange={(e) =>
                  setForm({ ...form, consent: e.target.checked })
                }
              />
              <span>
                Согласен сохранить на сервере имя, почту и результаты. Аудио не
                отправляется.
              </span>
            </label>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Подождите…" : mode === "login" ? "Войти" : "Создать кабинет"}
        </button>
      </form>
    </section>
  );
}
