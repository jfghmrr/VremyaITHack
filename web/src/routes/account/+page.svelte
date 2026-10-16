<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { account, login, logout, refreshAccount, register } from "#lib/api/account.svelte.ts";
  import ProviderButtons from "#lib/auth/ProviderButtons.svelte";
  import { safeReturn } from "#lib/auth/return.ts";
  import SignupComplete from "#lib/auth/SignupComplete.svelte";
  import AgeGroup from "#lib/auth/AgeGroup.svelte";
  import { ageProblem, parentNameFor, type AgeGroup as Group } from "#lib/auth/age.ts";
  import { api } from "#lib/api/http.ts";
  import { guestAttempts, type Attempt } from "#lib/history.svelte.ts";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Cat from "#lib/brand/Cat.svelte";

  let mode = $state<"login" | "register">("login");
  let email = $state("");
  let name = $state("");
  let password = $state("");
  let consent = $state(false);
  let ageGroup = $state("");
  let parentName = $state("");
  let parentConsent = $state(false);
  // Вход через Яндекс ID / VK ID: сервер возвращает ?signup=<токен> или ?authError=<код>.
  let signupToken = $state("");
  // Страница, с которой пришли ко входу (?return=…): туда вернёт вход через сервис.
  let returnTo = $state("/account");
  let authError = $state("");
  let sending = $state(false);
  let formError = $state("");
  let newName = $state("");
  let current = $state("");
  let next = $state("");
  let settingsMsg = $state("");
  let local = $state<Attempt[]>([]);
  let deletePassword = $state("");
  const CONFIRM_PHRASE = "УДАЛИТЬ";
  // Кабинет без пароля (вход через провайдера) подтверждает удаление словом.
  const passwordless = $derived(account.profile?.hasPassword === false);
  // Без почты пароль не задаётся: войти по нему нельзя, а удаление потребовало бы его вместо слова.
  const noEmail = $derived(!!account.profile && !account.profile.email);
  const providerNames: Record<string, string> = { yandex: "Яндекс ID", vk: "VK ID" };
  const providerLabel = $derived(
    (account.profile?.providers ?? []).map((p) => providerNames[p]).filter(Boolean).join(" и ") || "Яндекс ID или VK ID",
  );
  let deleteOpen = $state(false);
  let deleteError = $state("");
  let deleted = $state(false);

  const authErrors: Record<string, string> = {
    denied: "Вход отменён. Можно попробовать ещё раз или войти по почте.",
    state: "Ссылка для входа устарела или уже использована. Начни вход заново.",
  };

  onMount(() => {
    local = guestAttempts();
    // Страница пререндерится: параметры читаются в браузере.
    const params = new URLSearchParams(location.search);
    signupToken = params.get("signup") ?? "";
    returnTo = safeReturn(params.get("return"));
    const code = params.get("authError");
    if (code !== null) authError = authErrors[code] ?? "Не удалось войти через сервис. Попробуй ещё раз или войди по почте.";
  });

  function signupDone() {
    signupToken = "";
    void goto("/account", { replace: true, shallow: true });
  }

  $effect(() => {
    if (account.profile) {
      newName = account.profile.name;
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    sending = true;
    formError = "";
    try {
      if (mode === "login") await login(email, password);
      else {
        const problem = ageProblem(ageGroup, parentName, parentConsent);
        if (problem) {
          formError = problem;
          return;
        }
        await register(email, name, password, consent, ageGroup as Group, parentNameFor(ageGroup as Group, parentName));
      }
      password = "";
    } catch (err) {
      formError = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  async function rename(e: SubmitEvent) {
    e.preventDefault();
    settingsMsg = "";
    try {
      await api("me", { method: "PATCH", body: { name: newName } });
      await refreshAccount();
      settingsMsg = "Имя сохранено.";
    } catch (err) {
      settingsMsg = (err as Error).message;
    }
  }

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    settingsMsg = "";
    try {
      // Кабинет без пароля задаёт первый пароль: вместо текущего — слово подтверждения.
      const body = passwordless ? { confirm: CONFIRM_PHRASE, newPassword: next } : { currentPassword: current, newPassword: next };
      await api("password", { method: "POST", body });
      current = next = "";
      settingsMsg = passwordless ? "Пароль задан." : "Пароль изменён. Другие устройства вышли из кабинета.";
      await refreshAccount();
    } catch (err) {
      settingsMsg = (err as Error).message;
    }
  }

  async function exportData() {
    settingsMsg = "";
    try {
      const r = await fetch("/api/me/export", { credentials: "same-origin" });
      if (!r.ok) throw new Error("Не удалось получить данные. Войди снова и повтори.");
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: "perepev-data.json" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      settingsMsg = (err as Error).message;
    }
  }

  async function deleteAccount() {
    deleteOpen = false;
    deleteError = "";
    try {
      await api("me/delete", { method: "POST", body: passwordless ? { confirm: deletePassword.trim() } : { password: deletePassword } });
      deletePassword = "";
      deleted = true;
      mode = "login";
      account.profile = null;
      account.rating = null;
    } catch (err) {
      deleteError = (err as Error).message;
    }
  }

</script>
<svelte:head><title>Кабинет — Перепев</title></svelte:head>

{#if !account.loaded}
  <p class="muted pad">Загружаем кабинет…</p>
{:else if !account.profile}
  <div class="guest">
    <section class="why">
      <TitleStrip text="Кабинет" />
      <p class="lead">Сохраняет историю попыток на сервере и открывает рейтинговые дуэли. Петь без регистрации можно всегда.</p>
      {#if deleted}<p class="notice" role="status">Кабинет и все его данные удалены.</p>{/if}
      {#if account.offline}<p class="notice error" role="alert">Сервер кабинета недоступен. Одиночное пение работает без него.</p>{/if}
      {#if authError}<p class="notice error" role="alert">{authError}</p>{/if}
      <p class="small muted">
        Почта пока не подтверждается, а восстановления пароля нет: запомни пароль. Удалить кабинет вместе со всеми данными можно в любой момент в настройках.
      </p>
      {#if local.length}
        <p class="small muted">На этом устройстве {local.length} гостевых попыток. В кабинет они не переносятся: у них нет подтверждения владельца.</p>
      {/if}
      <div class="guest-cat" aria-hidden="true"><Cat mood={account.offline ? "unplugged" : "idle"} size={150} /></div>
    </section>
    {#if signupToken}
      <SignupComplete token={signupToken} oncomplete={signupDone} />
    {:else}
    <form class="auth sheet" onsubmit={submit} aria-labelledby="auth-title">
      <div class="tabs" role="tablist" aria-label="Вход или регистрация">
        <button type="button" role="tab" aria-selected={mode === "login"} onclick={() => ((mode = "login"), (formError = ""))}>Вход</button>
        <button type="button" role="tab" aria-selected={mode === "register"} onclick={() => ((mode = "register"), (formError = ""))}>Регистрация</button>
      </div>
      <h2 id="auth-title" class="visually-hidden">{mode === "login" ? "Вход" : "Регистрация"}</h2>
      <ProviderButtons {returnTo} />
      {#if mode === "register"}
        <label class="field">Имя в игре (видно другим игрокам)<input bind:value={name} autocomplete="nickname" required minlength="2" maxlength="32" /></label>
      {/if}
      <label class="field">Почта<input type="email" bind:value={email} autocomplete="email" required /></label>
      <label class="field">
        Пароль
        <input type="password" bind:value={password} autocomplete={mode === "login" ? "current-password" : "new-password"} required minlength="12" maxlength="128" aria-describedby={mode === "register" ? "password-hint" : undefined} />
      </label>
      {#if mode === "register"}<span id="password-hint" class="small muted hint">От 12 символов.</span>{/if}
      {#if mode === "register"}
        <AgeGroup name="register-age" bind:ageGroup bind:parentName bind:parentConsent />
        <label class="consent">
          <input type="checkbox" bind:checked={consent} required />
          <span>Даю <a href="/legal/consent" target="_blank">согласие на обработку персональных данных</a>. С <a href="/legal/privacy" target="_blank">политикой обработки данных</a> ознакомлен.</span>
        </label>
      {/if}
      {#if formError}<p class="notice error" role="alert">{formError}</p>{/if}
      <button class="btn btn-primary" disabled={sending}>{sending ? "Отправляем…" : mode === "login" ? "Войти" : "Создать кабинет"}</button>
    </form>
    {/if}
  </div>
{:else}
  <section class="account-settings">
    <div class="account-intro"><TitleStrip text="Мой аккаунт" fastener="binder" />
      <p>Личные данные и безопасность.</p><a class="btn btn-ink" href="/progress">К истории и прогрессу →</a>
      <Cat mood="idle" size={210} />
    </div>
    <div class="profile panel">      <div class="who">
        <span class="avatar" aria-hidden="true">{account.profile.name.slice(0, 1)}</span>
        <div>
          <h2>{account.profile.name}</h2>
          {#if account.profile.email}<p class="small muted">{account.profile.email}</p>{/if}
        </div>
      </div>
      <div class="settings">
        <h2>Настройки и безопасность</h2>
        <form onsubmit={rename}>
          <label class="field">Имя в игре (видно другим игрокам)<input bind:value={newName} minlength="2" maxlength="32" required /></label>
          <button class="btn">Сохранить имя</button>
        </form>
        {#if noEmail}
          <p class="small muted">Ты входишь через {providerLabel}. Пароль нужен только для входа по почте, поэтому у этого кабинета его нет.</p>
        {:else}
          <form onsubmit={changePassword}>
            {#if passwordless}
              <p class="small muted">Ты входишь через {providerLabel}, пароля у кабинета нет.</p>
            {:else}
              <label class="field">Текущий пароль<input type="password" bind:value={current} autocomplete="current-password" required minlength="12" /></label>
            {/if}
            <label class="field">Новый пароль<input type="password" bind:value={next} autocomplete="new-password" required minlength="12" maxlength="128" /></label>
            <button class="btn">{passwordless ? "Задать пароль" : "Сменить пароль"}</button>
          </form>
        {/if}
        {#if settingsMsg}<p class="small" role="status">{settingsMsg}</p>{/if}
        <div class="data">
          <button class="btn" type="button" onclick={exportData}>Скачать мои данные</button>
          <button class="btn btn-quiet" onclick={() => void logout()}>Выйти из кабинета</button>
        </div>
        <form class="danger-zone" onsubmit={(e) => { e.preventDefault(); deleteOpen = true; }}>
          <h3>Удалить кабинет</h3>
          <p class="small muted">Аккаунт, история, рейтинг и участие в дуэлях удаляются сразу и безвозвратно. Это и есть отзыв согласия на обработку данных.</p>
          {#if passwordless}
            <label class="field">Для подтверждения введи {CONFIRM_PHRASE}<input bind:value={deletePassword} autocomplete="off" required pattern={CONFIRM_PHRASE} /></label>
          {:else}
            <label class="field">Пароль для подтверждения<input type="password" bind:value={deletePassword} autocomplete="current-password" required minlength="12" /></label>
          {/if}
          {#if deleteError}<p class="notice error" role="alert">{deleteError}</p>{/if}
          <button class="btn danger">Удалить кабинет</button>
        </form>
      </div>
</div>
  </section>
{/if}
<ConfirmDialog
  open={deleteOpen}
  title="Удалить кабинет навсегда?"
  text="Все данные кабинета будут удалены без возможности восстановления."
  confirm="Удалить"
  cancel="Отмена"
  oncancel={() => (deleteOpen = false)}
  onconfirm={deleteAccount}
/>

<style>  .pad {
    padding-top: var(--s-8);
  }
  .guest {
    display: grid;
    grid-template-columns: minmax(0, 560px) minmax(320px, 430px);
    justify-content: space-evenly;
    gap: var(--s-8);
    align-items: start;
    padding-top: clamp(var(--s-4), 5vh, var(--s-7));
  }
  .why {
    display: grid;
    gap: var(--s-4);
    justify-items: start;
    max-width: 52ch;
  }
  .lead {
    font-size: var(--t-l);
    color: var(--on-room-2);
  }
  .guest-cat {
    margin-top: var(--s-2);
  }
  /* Форма — страница блокнота: сверху закладки-вкладки, слева поля. */
  .auth {
    display: grid;
    gap: var(--s-4);
    margin-top: var(--s-6);
    padding: var(--s-6) var(--s-6) var(--s-6) var(--s-7);
    background-image:
      linear-gradient(90deg, transparent 2.2rem, var(--margin) 2.2rem, var(--margin) calc(2.2rem + 1px), transparent calc(2.2rem + 1px)),
      var(--tex-paper);
  }
  .tabs {
    position: absolute;
    left: var(--s-7);
    top: -34px;
    display: flex;
    gap: 4px;
  }
  .tabs button {
    min-height: 36px;
    padding: 0 var(--s-4);
    border: 0;
    border-radius: 6px 6px 0 0;
    background: var(--paper-3) var(--tex-paper);
    color: var(--ink-2);
    font-weight: 600;
    cursor: pointer;
  }
  .tabs button:hover {
    color: var(--ink);
  }
  .tabs [aria-selected="true"] {
    min-height: 40px;
    margin-top: -4px;
    background-color: var(--paper-2);
    color: var(--ink);
    box-shadow: inset 0 3px 0 var(--accent);
  }
  .hint {
    margin-top: calc(-1 * var(--s-3));
  }
  .consent {
    display: flex;
    gap: var(--s-2);
    align-items: start;
    font-size: var(--t-s);
  }
  .consent input {
    margin-top: 3px;
  }
  .consent a {
    color: var(--accent);
  }
  .auth .btn-primary {
    justify-self: start;
  }

  .who {
    display: flex;
    gap: var(--s-4);
    align-items: center;
  }
  .who h2 {
    font-family: var(--font-hand);
    font-size: 2.2rem;
    letter-spacing: 0;
    line-height: 1;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 62px;
    height: 72px;
    padding-bottom: 10px;
    border: 5px solid #fff;
    border-bottom-width: 14px;
    background: var(--accent);
    color: var(--paper);
    font-family: var(--font-block);
    font-size: var(--t-xl);
    box-shadow: var(--shadow-sticker);
    transform: rotate(-4deg);
  }
  .settings {
    display: grid;
    gap: var(--s-4);
  }
  .settings h2 {
    cursor: pointer;
    font-weight: 600;
    min-height: var(--control-h);
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--rule);
  }
  .settings form {
    display: grid;
    gap: var(--s-3);
    margin-bottom: var(--s-4);
    justify-items: start;
  }
  .settings .field {
    width: 100%;
  }
  .data {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .danger-zone {
    padding-top: var(--s-4);
    border-top: 1px dashed var(--line-strong);
  }
  .danger-zone h3 {
    font-size: var(--t-m);
  }
  .btn.danger {
    --btn-bg: var(--paper-2);
    --btn-ink: var(--accent);
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .account-settings { display: grid; grid-template-columns: minmax(250px,.75fr) minmax(0,1fr); gap: 60px; max-width: 1050px; margin: 24px auto 0; height: calc(100svh - var(--chrome) - 24px); }
  .account-intro { display: flex; flex-direction: column; gap: 24px; align-items: flex-start; padding-top: 20px; }
  .account-intro p { color: var(--on-room-2); }
  .profile { display: grid; align-content: start; gap: 24px; min-height: 0; overflow-y: auto; padding: 28px 32px; color: var(--ink); background: var(--paper-2) var(--tex-paper); --muted: var(--ink-2); }
  .settings form { width: 100%; }
  .settings h2 { font: 700 1.6rem/1.2 var(--font-hand); }
  /* Сенсорный экран или не wide: вкладки входа не ниже 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .tabs button, .tabs [aria-selected="true"] { min-height: var(--tap); }
  }
  /* Не wide: одна колонка, форма во всю ширину. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .guest, .account-settings { grid-template-columns: minmax(0, 1fr); height: auto; gap: 24px; }
    .guest-cat { display: none; } .account-intro :global(.cat) { display: none; }
    .profile { overflow: visible; padding: 24px; }
  }
  /* compact: поля блокнота уже, кнопки данных в столбик. */
  @media (max-width: 599px) {
    .auth { padding: var(--s-6) var(--s-4) var(--s-5) var(--s-6); }
    .tabs { left: var(--s-5); }
    .profile { padding: 20px 16px; }
  }
</style>
