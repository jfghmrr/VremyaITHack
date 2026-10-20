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
  import Star from "#lib/brand/Star.svelte";
  import Pin from "#lib/brand/Pin.svelte";
  import Asset from "#lib/brand/Asset.svelte";
  import { count } from "#lib/ui/format.ts";

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

  // После выхода форма открывается чистой на вкладке «Вход» (QA L1).
  async function signOut() {
    await logout();
    mode = "login";
    email = "";
    name = "";
    password = "";
    consent = false;
    formError = "";
  }

  // Подсказки проверки формы по-русски, а не на языке браузера (QA L24).
  function russianValidity(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = el.validity;
    el.setCustomValidity(
      v.valueMissing
        ? el.type === "checkbox"
          ? "Отметь этот пункт, чтобы продолжить."
          : el.type === "radio"
            ? "Выбери один из вариантов."
            : "Заполни это поле."
        : v.tooShort
          ? `Нужно не меньше ${el.minLength} символов, сейчас ${el.value.length}.`
          : v.typeMismatch
            ? "Проверь адрес почты: в нём должен быть знак @."
            : v.patternMismatch
              ? "Введи слово точно так, как в подсказке."
              : "",
    );
  }
  const resetValidity = (e: Event) => (e.target as HTMLInputElement).setCustomValidity?.("");

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
  <!-- Две части по центру: слева — что даёт кабинет и честные оговорки, справа — форма,
       из-за которой выглядывает кот. На телефоне форма сразу под вступлением. -->
  <div class="guest">
    <header class="head">
      <TitleStrip text="Кабинет" />
      <p class="lead">Сохраняет историю попыток на сервере и открывает рейтинговые дуэли. Петь без регистрации можно всегда.</p>
      {#if deleted}<p class="notice" role="status">Кабинет и все его данные удалены.</p>{/if}
      {#if account.offline}<p class="notice error" role="alert">Сервер кабинета недоступен. Одиночное пение работает без него.</p>{/if}
      {#if authError}<p class="notice error" role="alert">{authError}</p>{/if}
    </header>
    <section class="perks" aria-labelledby="perks-title">
      <h2 id="perks-title">Что даёт кабинет</h2>
      <ul role="list">
        <li><span class="ico" aria-hidden="true"><Asset name="cassettes/cassette-black-blank" width={54} /></span><span><strong>История на сервере</strong>Балл и оценки последних 100 попыток — на любом устройстве.</span></li>
        <li><span class="ico" aria-hidden="true"><Star variant="patch" size={46} /></span><span><strong>Рейтинговые дуэли и таблица лидеров</strong>Соперник близкого уровня, ранг и место в общей таблице.</span></li>
        <li><span class="ico" aria-hidden="true"><Pin kind="heart" size={42} /></span><span><strong>Друзья и комнаты на двоих</strong>Друзья по личному коду, комнаты «Кто лучше» и «Вместе».</span></li>
        <li><span class="ico" aria-hidden="true"><Asset name="doodles/note-pair-s01" width={42} /></span><span><strong>Свои треки</strong>Отрывок своей песни на 15–60 с: виден только тебе, живёт сутки.</span></li>
        <li><span class="ico" aria-hidden="true"><Asset name="hardware/binder-clip-s03" width={30} /></span><span><strong>Данные под твоим контролем</strong>Скачать всё, что хранится о тебе, или удалить кабинет навсегда.</span></li>
      </ul>
    </section>
    <p class="fine small">
      Почта пока не подтверждается, а восстановления пароля нет: запомни пароль.
      {#if local.length}На этом устройстве {count(local.length, ["гостевая попытка", "гостевые попытки", "гостевых попыток"])}: в кабинет {local.length === 1 ? "она не переносится" : "они не переносятся"}, у гостевых попыток нет подтверждения владельца.{:else}Гостевые попытки из браузера в кабинет не переносятся: у них нет подтверждения владельца.{/if}
    </p>
    <div class="door">
      <span class="peek" aria-hidden="true"><Cat mood={account.offline ? "unplugged" : "idle"} size="100%" loading="eager" /></span>
    {#if signupToken}
      <SignupComplete token={signupToken} oncomplete={signupDone} />
    {:else}
    <form class="auth sheet" onsubmit={submit} aria-labelledby="auth-title" oninvalidcapture={russianValidity} oninputcapture={resetValidity} onchangecapture={resetValidity}>
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
      <!-- Что работает без кабинета: гость решает, нужен ли он ему сейчас (не во время завершения входа). -->
      {#if !signupToken}
      <aside class="free sheet kraft" aria-labelledby="free-title">
        <span class="tape" style:left="22px" style:top="-12px" style:rotate="-4deg" aria-hidden="true"></span>
        <h2 id="free-title">Без кабинета тоже можно</h2>
        <ul>
          <li>петь любую песню каталога и смотреть разбор;</li>
          <li>тренировать трудные места;</li>
          <li>отправить другу вызов-призрак по ссылке;</li>
          <li>хранить историю и достижения в этом браузере.</li>
        </ul>
        <a class="btn" href="/songs">К песням</a>
      </aside>
      {/if}
    </div>
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
          <button class="btn btn-quiet" onclick={() => void signOut()}>Выйти из кабинета</button>
        </div>
        <form class="danger-zone" onsubmit={(e) => { e.preventDefault(); deleteOpen = true; }} oninvalidcapture={russianValidity} oninputcapture={resetValidity}>
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
  /* Гость: композиция по центру окна (не больше 1180 px), а не по краям контейнера с дырой
     посередине. Слева ярлык, вступление, «Что даёт кабинет» и оговорки; справа форма. */
  .guest {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(21rem, 26rem);
    grid-template-areas: "head door" "perks door" "fine door";
    grid-template-rows: auto auto 1fr;
    gap: var(--s-5) clamp(40px, 4.5vw, 80px);
    align-items: start;
    /* В rem: на xwide (шрифт до 21 px) группа растёт вместе с текстом. */
    width: min(100%, 70rem);
    margin-inline: auto;
    padding: var(--title-top) 0 var(--s-5);
  }
  .head {
    grid-area: head;
    display: grid;
    gap: var(--s-4);
    justify-items: start;
  }
  .lead {
    max-width: 46ch;
    font-size: var(--t-l);
    color: var(--on-room-2);
  }
  /* Наклейки на стене: значок из набора, заголовок пункта и одна строка пояснения. */
  .perks {
    grid-area: perks;
    display: grid;
    gap: var(--s-4);
  }
  .perks h2 {
    color: var(--paper);
    font: 700 2.1rem/1 var(--font-hand);
    letter-spacing: 0;
  }
  .perks ul {
    display: grid;
    gap: var(--s-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .perks li {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: var(--s-4);
    align-items: center;
    color: var(--on-room-2);
    font-size: var(--t-s);
    line-height: 1.4;
  }
  .perks strong {
    display: block;
    color: var(--on-room);
    font-size: var(--t-m);
    font-weight: 650;
  }
  .ico {
    display: grid;
    place-items: center;
    width: 58px;
    height: 46px;
  }
  .ico :global(img) {
    filter: drop-shadow(0 3px 3px rgb(0 0 0 / 0.55));
  }
  .ico :global(.cutout-asset) {
    rotate: -6deg;
  }
  /* Честные оговорки — мелким шрифтом под пунктирной чертой, без отдельной карточки. */
  .fine {
    grid-area: fine;
    max-width: 72ch;
    padding-top: var(--s-3);
    border-top: 1px dashed var(--room-line);
    color: var(--on-room-2);
  }
  /* Колонка формы: кот выглядывает из-за верхнего края тетради справа, закладки — слева. */
  .door {
    grid-area: door;
    display: grid;
    min-width: 0;
  }
  .peek {
    position: relative;
    z-index: 0;
    justify-self: end;
    width: 8.25rem;
    margin: 0 var(--s-5) -3.5rem 0;
    pointer-events: none;
  }
  .door > :global(.sheet) {
    z-index: 1;
  }
  .free {
    display: grid;
    justify-items: start;
    gap: var(--s-2);
    margin-top: var(--s-6);
    padding: var(--s-5) var(--s-5) var(--s-4);
    font-size: var(--t-s);
  }
  .free h2 {
    font: 700 1.7rem/1 var(--font-hand);
    letter-spacing: 0;
  }
  .free ul {
    margin: 0 0 var(--s-2);
    padding-left: 1.1em;
    color: #3b342b;
  }
  /* wide ниже «wide-note» (tokens.css): записка не помещается без прокрутки, если сервер показывает
     кнопки Яндекс ID и VK ID (на 860-939 px страница прокручивалась на ~65 px) — форма важнее. */
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 939px) {
    .free { display: none; }
  }
  /* wide на высоком окне («wide-tall», от 900 px): отступы растут с высотой окна. */
  @media (min-width: 1100px) and (min-height: 900px) {
    .guest { row-gap: clamp(24px, 3.4svh, 44px); }
    .perks ul { gap: clamp(12px, 2.2svh, 26px); }
    .free { margin-top: clamp(32px, 4svh, 52px); }
  }
  /* wide на низком окне («wide-low», 1280×720): пункты плотнее, страница без прокрутки. */
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 760px) {
    .guest { row-gap: var(--s-4); }
    .perks ul { gap: var(--s-2); }
  }
  /* Форма — страница блокнота: сверху закладки-вкладки, слева поля. */
  .auth {
    /* Красная линия полей блокнота: левее подписей и полей, а не по первой букве. */
    --margin-x: 2.2rem;
    display: grid;
    gap: var(--s-4);
    margin-top: var(--s-6);
    padding: var(--s-6) var(--s-6) var(--s-6) var(--s-7);
    background-image:
      linear-gradient(90deg, transparent var(--margin-x), var(--margin) var(--margin-x), var(--margin) calc(var(--margin-x) + 1px), transparent calc(var(--margin-x) + 1px)),
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

  /* Настройки прокручиваются вместе со страницей: «Удалить кабинет» не прячется во внутренней прокрутке. */
  /* Вступление и лист настроек — одна группа по центру: справа не остаётся пустая треть окна. */
  .account-settings { display: grid; grid-template-columns: minmax(240px, 20rem) minmax(0, 47.5rem); justify-content: center; gap: 60px; width: min(100%, 74rem); margin-inline: auto; padding: var(--title-top) 0 var(--s-5); align-items: start; }
  .account-intro { display: flex; flex-direction: column; gap: 24px; align-items: flex-start; }
  .account-intro p { color: var(--on-room-2); }
  .profile { display: grid; align-content: start; gap: 24px; min-height: 0; max-width: 47.5rem; padding: 28px 32px; color: var(--ink); background: var(--paper-2) var(--tex-paper); --muted: var(--ink-2); }
  .settings form { width: 100%; }
  .settings h2 { font: 700 1.6rem/1.2 var(--font-hand); }
  /* Сенсорный экран или не wide: вкладки входа не ниже 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .tabs button, .tabs [aria-selected="true"] { min-height: var(--tap); }
  }
  /* wide: закладки формы помещаются в полосу, где выглядывает кот, — без лишнего отступа. */
  @media (min-width: 1100px) and (min-height: 521px) {
    .door .auth { margin-top: 0; }
  }
  /* Не wide: одна колонка — вступление, форма (не шире 560 px), что даёт кабинет, оговорки.
     Кот не выглядывает: форма сразу под вступлением. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .guest, .account-settings { grid-template-columns: minmax(0, 1fr); height: auto; gap: 24px; padding-inline: 0; }
    .guest { display: flex; flex-direction: column; }
    .door { display: contents; }
    .door > :global(form) { order: 1; width: min(100%, 560px); }
    .perks { order: 2; } .fine { order: 3; } .free { order: 4; width: min(100%, 560px); margin-top: 0; }
    .peek { display: none; } .account-intro :global(.cat) { display: none; }
    .profile { overflow: visible; padding: 24px; }
  }
  /* compact: поля блокнота уже, кнопки данных в столбик. */
  @media (max-width: 599px) {
    .perks h2 { font-size: 1.85rem; }
    .perks li { grid-template-columns: 46px minmax(0, 1fr); gap: var(--s-3); }
    .ico { width: 46px; }
    .auth { --margin-x: 1.3rem; padding: var(--s-6) var(--s-4) var(--s-5) var(--s-6); }
    .tabs { left: var(--s-5); }
    .profile { padding: 20px 16px; }
  }
</style>
