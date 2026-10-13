import { useState } from "react";
import type { Profile } from "./profile";
export function ProfileScreen({
  profile,
  onSave,
  onGuest,
  onLogout,
}: {
  profile: Profile | null;
  onSave: (name: string) => void;
  onGuest: () => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState(profile?.name || ""),
    [accepted, setAccepted] = useState(!!profile),
    [error, setError] = useState("");
  return (
    <section className="registration-page">
      <div className="registration-story">
        <span className="eyebrow">ТВОЙ ГОЛОС. ТВОЯ ИСТОРИЯ.</span>
        <h1>{profile ? "С возвращением." : "Начнём с тебя."}</h1>
        <p className="lead">
          Один профиль для твоих дублей,
          <br />
          личных рекордов и новых попыток.
        </p>
        <div className="registration-trace" aria-hidden="true">
          <svg viewBox="0 0 440 160">
            <path d="M0 120H65V92H125V48H190V68H260V20H320V58H440" />
            <path d="M0 136H65V108H125V64H190V84H260V36H320V74H440" />
            <path d="M0 152H65V124H125V80H190V100H260V52H320V90H440" />
          </svg>
        </div>
        <p className="fine">
          Запись голоса остаётся в памяти вкладки.
          <br />В историю сохраняются только результаты.
        </p>
      </div>
      <form
        className="registration-card"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (!accepted) {
            setError("Подтверди сохранение профиля на устройстве.");
            return;
          }
          try {
            onSave(name);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <span className="eyebrow">
          {profile ? "ЛОКАЛЬНЫЙ ПРОФИЛЬ" : "РЕГИСТРАЦИЯ"}
        </span>
        <h2>{profile ? "Твой профиль" : "Как тебя представить?"}</h2>
        <p>
          Это профиль в этом браузере. Пароль и почта не нужны: серверного
          аккаунта здесь нет.
        </p>
        <label className="field">
          Твоё имя
          <input
            value={name}
            minLength={2}
            maxLength={32}
            required
            autoComplete="nickname"
            placeholder="Например, Саша"
            onChange={(e) => setName(e.target.value)}
          />
          <span className="fine">
            От 2 до 32 символов. Имя будет видно в ссылке-вызове.
          </span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            Сохранить профиль и результаты в этом браузере. Они не переносятся
            на другие устройства.
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit">
          {profile ? "Сохранить профиль" : "Создать профиль"}
        </button>
        <button className="secondary" type="button" onClick={onGuest}>
          {profile ? "К песням" : "Продолжить без регистрации"}
        </button>
        {profile && (
          <button className="text-button" type="button" onClick={onLogout}>
            Выйти из профиля
          </button>
        )}
        <p className="fine">
          Очистка данных браузера удалит профиль и историю.
        </p>
      </form>
    </section>
  );
}
