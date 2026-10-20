<script lang="ts">
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { api } from "#lib/api/http.ts";
  import type { Friend, Friends } from "#lib/api/types.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Cat from "#lib/brand/Cat.svelte";
  import Star from "#lib/brand/Star.svelte";
  import Polaroid from "#lib/brand/Polaroid.svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  let data = $state<Friends | null>(null), code = $state(""), busy = $state(false);
  let error = $state(""), message = $state(""), removing = $state<Friend | null>(null);
  let tab = $state<"friends" | "requests">("friends");
  $effect(() => {
    const id = account.profile?.id;
    data = null; error = "";
    if (!id) return;
    let active = true;
    const refresh = async () => {
      if (document.hidden) return;
      try { const next = await api<Friends>("friends"); if (active) { data = next; error = ""; } }
      catch (e) { if (active) error = (e as Error).message; }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  });
  async function update(path: string, method: string, body?: unknown) {
    busy = true; error = ""; message = "";
    try { data = await api<Friends>(path, { method, body }); return true; }
    catch (e) { error = (e as Error).message; return false; }
    finally { busy = false; }
  }
  async function send(e: SubmitEvent) {
    e.preventDefault();
    const id = code.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { error = "Вставь код целиком: он находится на странице «Друзья» у твоего друга."; return; }
    if (await update("friends", "POST", { id })) {
      code = ""; tab = "requests";
      message = data?.incoming.some(f => f.id === id) ? "Друг уже прислал заявку. Подтверди её ниже." : data?.friends.some(f => f.id === id) ? "Вы уже друзья." : "Заявка отправлена. Ждём подтверждения друга.";
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(account.profile!.id); message = "Код скопирован"; }
    catch { message = "Выдели и скопируй код из поля вручную."; }
  }
  async function refresh() {
    error = "";
    try { data = await api<Friends>("friends"); } catch (e) { error = (e as Error).message; }
  }
</script>
<svelte:head><title>Друзья — Перепев</title></svelte:head>
{#snippet stepItems(member: boolean)}
  <li class="step">
    <span class="photo" aria-hidden="true"><Polaroid><Cat mood="empty" size="92%" /></Polaroid></span>
    <span class="num" aria-hidden="true"><Star variant="patch" size={60}>1</Star></span>
    <h3><span class="visually-hidden">Шаг 1: </span>Твой личный код</h3>
    <p>{member ? "Скопируй свой код из поля «Мой код» и отправь другу" : "В кабинете у тебя есть личный код. Скопируй его и отправь другу"} — в мессенджере или лично.</p>
  </li>
  <li class="step">
    <span class="photo" aria-hidden="true"><Polaroid><Cat mood="happy" size="86%" /></Polaroid></span>
    <span class="num" aria-hidden="true"><Star variant="patch" size={60}>2</Star></span>
    <h3><span class="visually-hidden">Шаг 2: </span>Заявка и подтверждение</h3>
    <p>Один из вас вставляет код другого и отправляет заявку, второй подтверждает её во вкладке «Заявки».</p>
  </li>
  <li class="step">
    <span class="photo" aria-hidden="true"><Polaroid><Cat mood="singing" size="86%" /></Polaroid></span>
    <span class="num" aria-hidden="true"><Star variant="patch" size={60}>3</Star></span>
    <h3><span class="visually-hidden">Шаг 3: </span>Пойте вместе</h3>
    <p>Создай комнату в «Дуэлях» и отправь другу ссылку: «Кто лучше» или «Вместе» по очереди. Или спой песню и пошли вызов-призрак.</p>
  </li>
{/snippet}
<section class="friends-page" class:guest-page={account.loaded && !account.profile}>
  <header><TitleStrip text="Свои люди" fastener="binder" />{#if account.profile}<a href="/duels" class="btn">В дуэли →</a>{/if}</header>
  {#if account.loaded && !account.profile}
    <!-- Гость: что такое друзья, вход и «В дуэли» рядом, ниже — как добавить друга в три шага. -->
    <div class="sheet guest">
      <span class="guest-cat" aria-hidden="true"><Cat mood="groove" size="100%" /></span>
      <div class="guest-text">
        <h2>Вместе интереснее</h2>
        <p>Друзья — твой список людей, с которыми ты поёшь дуэтом и соревнуешься. Войди в кабинет, чтобы добавить друзей и сохранить свой список.</p>
      </div>
      <div class="guest-actions">
        <a class="btn btn-primary" href={signInHref("/friends")}>Войти или зарегистрироваться</a>
        <a class="btn" href="/duels">В дуэли →</a>
      </div>
    </div>
    <section class="how" aria-labelledby="how-title">
      <h2 id="how-title">Как добавить друга</h2>
      <ol class="steps" role="list">{@render stepItems(false)}</ol>
      <p class="privacy small">Друг видит только твоё имя. Почта и история исполнения остаются в твоём кабинете.</p>
    </section>
  {:else if account.profile}
    <div class="address-book">
      <aside class="sheet add">
        <h2>Добавить друга</h2>
        <p>Обменяйтесь личными кодами. Вторая сторона подтверждает заявку.</p>
        <form onsubmit={send}>
          <label class="field"><span>Код друга</span><input bind:value={code} placeholder="Вставь код друга" maxlength="36" required autocomplete="off" spellcheck="false" /></label>
          <button class="btn btn-primary" disabled={busy}>Отправить заявку</button>
        </form>
        <div class="my-code"><label class="field"><span>Мой код</span><input readonly value={account.profile.id} aria-label="Мой код" onclick={e => e.currentTarget.select()} /></label><button class="btn" onclick={copy}>Скопировать код</button></div>
        <p class="small">Друг видит только твоё имя. Почта и история исполнения остаются в твоём кабинете.</p>
        <div class="guide"><Cat mood="groove" size={95} /><span>Собери свою<br />музыкальную компанию</span></div>
      </aside>
      <div class="sheet list">
        <div class="list-top"><div class="tabs segmented" role="group" aria-label="Список друзей"><button aria-pressed={tab === "friends"} onclick={() => tab = "friends"}>Друзья · {data?.friends.length ?? 0}</button><button aria-pressed={tab === "requests"} onclick={() => tab = "requests"}>Заявки · {data ? data.incoming.length + data.outgoing.length : 0}</button></div><button class="refresh" onclick={refresh} disabled={busy}>Обновить</button></div>
        {#if error}<p class="notice error" role="alert">{error}</p>{/if}
        {#if message}<p class="notice" role="status">{message}</p>{/if}
        <div class="entries">
        {#if !data}<p>Загружаем адресную книгу…</p>
        {:else if tab === "friends"}
          {#if !data.friends.length}<div class="empty"><h2>Здесь будут твои друзья</h2><p>Отправь первую заявку по коду. После подтверждения друг появится здесь.</p></div>{/if}
          {#each data.friends as f (f.id)}<article class="person"><span class="avatar" aria-hidden="true">{f.name.slice(0,1)}</span><strong>{f.name}</strong><button class="remove" disabled={busy} aria-label="Удалить из друзей: {f.name}" onclick={() => removing = f}>Удалить</button></article>{/each}
          {#if data.friends.length}<div class="duel-note"><h3>Спойте вместе</h3><p>Создай комнату в «Дуэлях» и отправь другу её ссылку. Вы начнёте одновременно, когда оба будете готовы.</p><a class="btn" href="/duels">Создать дуэль с другом →</a></div>{/if}
        {:else}
          <h2>Входящие</h2>
          {#if !data.incoming.length}<p class="muted">Новых заявок нет.</p>{/if}
          {#each data.incoming as f (f.id)}<article class="request"><strong>{f.name}</strong><div><button class="btn btn-primary" disabled={busy} onclick={async () => { if (await update(`friends/${f.id}/accept`, "POST")) message = `${f.name} теперь в друзьях`; }}>Принять</button><button class="btn" disabled={busy} onclick={() => update(`friends/${f.id}`, "DELETE")}>Отклонить</button></div></article>{/each}
          <h2 class="outgoing">Отправленные</h2>
          {#if !data.outgoing.length}<p class="muted">Нет отправленных заявок.</p>{/if}
          {#each data.outgoing as f (f.id)}<article class="person"><strong>{f.name}</strong><span class="small muted">Ждём ответа</span><button class="remove" disabled={busy} onclick={() => update(`friends/${f.id}`, "DELETE")}>Отменить</button></article>{/each}
        {/if}
        </div>
        <!-- Пустой список: те же три шага на листе, а не пустая страница с одной фразой. -->
        {#if data && tab === "friends" && !data.friends.length}<ol class="steps on-paper" role="list" aria-label="Как добавить друга">{@render stepItems(true)}</ol>{/if}
      </div>
    </div>
  {:else}<p class="notice">Проверяем кабинет…</p>{/if}
</section>
<ConfirmDialog open={!!removing} title="Удалить из друзей?" text={removing ? `${removing.name} исчезнет из твоего списка. Позже можно отправить новую заявку.` : ""} confirm="Удалить" cancel="Оставить" oncancel={() => removing = null} onconfirm={async () => { const f = removing; removing = null; if (f) await update(`friends/${f.id}`, "DELETE"); }} />
<style>
  /* Ярлык заголовка на той же высоте и отступе, что на других страницах (--title-top). */
  .friends-page { padding: var(--title-top) 2% 20px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 26px; }
  .address-book { display: grid; grid-template-columns: minmax(280px, .8fr) minmax(0, 1.3fr); gap: 24px; }
  .sheet { padding: 24px; }
  h2 { font: 700 30px/1 var(--font-hand); margin-bottom: 12px; }
  p { line-height: 1.45; }
  .add { display: flex; flex-direction: column; gap: 15px; }
  form, .my-code { display: grid; gap: 10px; }
  .my-code { padding-top: 15px; border-top: 1px dashed var(--line-strong); }
  .my-code input { font: 12px var(--font-mono); }
  .list-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .list-top { justify-content: space-between; margin-bottom: 18px; }
  .refresh, .remove { background: transparent; border: 0; text-decoration: underline; color: var(--accent); padding: 8px 0; }
  .entries { max-height: 380px; overflow: auto; }
  .person, .request { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--rule); padding: 12px 0; }
  .person strong, .request strong { flex: 1; overflow-wrap: anywhere; }
  .avatar { display: grid; place-items: center; width: 36px; height: 36px; background: var(--accent); color: var(--paper); rotate: -4deg; }
  .request div { display: flex; gap: 8px; }
  .outgoing { margin-top: 28px; }
  .duel-note { margin-top: 24px; padding: 18px; border: 1px dashed var(--line-strong); display: grid; gap: 10px; }
  .guide { display: flex; align-items: center; justify-content: center; gap: 15px; font: 700 23px/1 var(--font-hand); }
  /* Гость: лист с котом и входом, под ним три шага на стене — одна группа по центру окна. */
  .guest-page { width: min(100%, 72rem); margin-inline: auto; }
  .guest { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr) auto; align-items: center; gap: var(--s-6); padding: var(--s-5) var(--s-7) var(--s-5) var(--s-6); }
  .guest-cat { display: block; }
  .guest-text { display: grid; gap: var(--s-3); justify-items: start; max-width: 58ch; }
  .guest h2 { margin: 0; font-size: 2.3rem; }
  /* Вход и «В дуэли» — столбиком справа на листе: лист не пустует справа от текста. */
  .guest-actions { display: grid; justify-items: stretch; gap: var(--s-3); }
  /* Узкий телефон: «Войти или зарегистрироваться» переносится внутри листа, а не вылезает за край. */
  .guest .btn { max-width: 100%; white-space: normal; line-height: 1.1; padding-block: var(--s-2); }
  .how { display: grid; gap: var(--s-5); margin-top: var(--s-6); }
  .how > h2 { margin: 0; color: var(--paper); font-size: 2.1rem; }
  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-6); margin: 0; padding: 0; list-style: none; }
  .step { position: relative; display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); grid-template-rows: auto 1fr; column-gap: var(--s-5); row-gap: var(--s-2); align-items: start; }
  .photo { grid-row: span 2; display: block; width: 7.5rem; rotate: -3deg; }
  .step:nth-child(2) .photo { rotate: 2.5deg; }
  .step:nth-child(3) .photo { rotate: -1.5deg; }
  /* Номер шага на красной звезде: светлая цифра в тёмной обводке, иначе она тонет в фактуре наклейки. */
  .num { position: absolute; left: -22px; top: -22px; rotate: -10deg; font: 700 1.95rem/1 var(--font-poster); }
  .num :global(.content) { color: var(--paper-2); -webkit-text-stroke: 1.5px var(--ink); paint-order: stroke fill; text-shadow: 0 1px 2px rgb(0 0 0 / 0.6); }
  .step h3 { margin: 0; color: var(--paper); font: 700 1.6rem/1.05 var(--font-hand); letter-spacing: 0; }
  .step p { color: var(--on-room-2); font-size: var(--t-s); }
  .privacy { color: var(--on-room-2); padding-top: var(--s-3); border-top: 1px dashed var(--room-line); }
  /* Шаги на листе адресной книги (пустой список): столбиком, чернилами, фото меньше. */
  .steps.on-paper { grid-template-columns: minmax(0, 1fr); gap: var(--s-3); padding: var(--s-3) 0 0 var(--s-3); border-top: 1px dashed var(--line-strong); }
  .on-paper .step { grid-template-columns: 5rem minmax(0, 1fr); }
  .on-paper .photo { width: 5rem; }
  .on-paper .num { left: -16px; top: -14px; font-size: 1.35rem; }
  .on-paper .num :global(.star) { width: 46px; }
  .on-paper h3 { color: var(--ink); font-size: 1.45rem; }
  .on-paper p { color: var(--ink-2); }
  .empty { padding: 20px 0 24px; }
  /* «wide-snug» (tokens.css): вошедший на низком окне — листы плотнее, без кота-подсказки. */
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 850px) { header { margin-bottom: 18px; } .sheet { padding: 18px 22px; } .add { gap: 10px; } .guide { display: none; } .entries { max-height: 320px; } }
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) { .refresh, .remove { min-height: var(--tap); padding-inline: 4px; } }
  /* Не wide: ярлык и листы от того же края, что на остальных страницах (без лишних 2 %). */
  @media not all and (min-width: 1100px) and (min-height: 521px) { .friends-page { padding-inline: 0; } }
  /* wide на высоком окне (от 900 px, «wide-tall» в tokens.css): ярлык, лист и шаги — одна группа
     по центру по вертикали между шапкой и подвалом, а не наверху с пустой нижней половиной.
     Страница статична: у гостя нет вкладок, у вошедшего высоту адресной книги задаёт левый лист
     (правый растягивается до него), поэтому при переключении «Друзья / Заявки» ничего не прыгает. */
  @media (min-width: 1100px) and (min-height: 900px) {
    .friends-page { min-height: calc(100svh - var(--chrome)); display: flex; flex-direction: column; justify-content: center; padding-block: var(--s-5); }
  }
  /* wide на высоком окне («wide-taller», от 960 px): шаги — три полароида крупнее, текст под ними; отступы
     растут с высотой окна, и нижняя половина экрана не пустует. */
  @media (min-width: 1100px) and (min-height: 960px) {
    .guest-page header { margin-bottom: clamp(26px, 3svh, 40px); }
    .guest { padding-block: clamp(24px, 3svh, 40px); }
    .how { margin-top: clamp(32px, 5svh, 64px); gap: clamp(24px, 3svh, 40px); }
    .steps:not(.on-paper) .step { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; justify-items: start; }
    .steps:not(.on-paper) .photo { grid-row: auto; width: clamp(9rem, 16svh, 12rem); margin-bottom: var(--s-3); }
    .privacy { margin-top: var(--s-3); }
  }
  /* Не wide: шаги в столбик (фото слева, текст справа), лист входа во всю ширину. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .guest { grid-template-columns: 7.5rem minmax(0, 1fr); padding: var(--s-5); column-gap: var(--s-5); }
    .guest-actions { grid-column: 2; display: flex; flex-wrap: wrap; }
    .steps { grid-template-columns: minmax(0, 1fr); gap: var(--s-5); }
    .how { margin-top: var(--s-6); }
  }
  @media (max-width: 599px) {
    .address-book { grid-template-columns: 1fr; } header { flex-wrap: wrap; } .sheet { padding: 20px; } .request { flex-wrap: wrap; } .entries { max-height: none; }
    .guest { grid-template-columns: minmax(0, 1fr); justify-items: center; text-align: center; gap: var(--s-3); }
    .guest-cat { width: 7.5rem; }
    .guest-text { justify-items: center; }
    .guest-actions { grid-column: auto; justify-content: center; }
    .step { grid-template-columns: 5.5rem minmax(0, 1fr); column-gap: var(--s-4); }
    .photo { width: 5.5rem; }
  }
</style>
