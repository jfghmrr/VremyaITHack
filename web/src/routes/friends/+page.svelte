<script lang="ts">
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { api } from "#lib/api/http.ts";
  import type { Friend, Friends } from "#lib/api/types.ts";
  import TitleStrip from "#lib/brand/TitleStrip.svelte";
  import Cat from "#lib/brand/Cat.svelte";
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
<section class="friends-page">
  <header><TitleStrip text="Свои люди" fastener="binder" /><a href="/duels" class="btn">В дуэли →</a></header>
  {#if account.loaded && !account.profile}
    <div class="sheet guest"><Cat mood="shy" size={150} /><h2>Вместе интереснее</h2><p>Войди в кабинет, чтобы добавить друзей и сохранить свой список.</p><a class="btn btn-primary" href={signInHref("/friends")}>Войти или зарегистрироваться</a></div>
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
        <div class="guide"><Cat mood="shy" size={95} /><span>Собери свою<br />музыкальную компанию</span></div>
      </aside>
      <div class="sheet list">
        <div class="list-top"><div class="tabs" role="group" aria-label="Список друзей"><button class="btn" class:chosen={tab === "friends"} aria-pressed={tab === "friends"} onclick={() => tab = "friends"}>Друзья · {data?.friends.length ?? 0}</button><button class="btn" class:chosen={tab === "requests"} aria-pressed={tab === "requests"} onclick={() => tab = "requests"}>Заявки · {data ? data.incoming.length + data.outgoing.length : 0}</button></div><button class="refresh" onclick={refresh} disabled={busy}>Обновить</button></div>
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
      </div>
    </div>
  {:else}<p class="notice">Проверяем кабинет…</p>{/if}
</section>
<ConfirmDialog open={!!removing} title="Удалить из друзей?" text={removing ? `${removing.name} исчезнет из твоего списка. Позже можно отправить новую заявку.` : ""} confirm="Удалить" cancel="Оставить" oncancel={() => removing = null} onconfirm={async () => { const f = removing; removing = null; if (f) await update(`friends/${f.id}`, "DELETE"); }} />
<style>
  .friends-page { padding: 20px 2%; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 26px; }
  .address-book { display: grid; grid-template-columns: minmax(280px, .8fr) minmax(0, 1.3fr); gap: 24px; }
  .sheet { padding: 24px; }
  h2 { font: 700 30px/1 var(--font-hand); margin-bottom: 12px; }
  p { line-height: 1.45; }
  .add { display: flex; flex-direction: column; gap: 15px; }
  form, .my-code { display: grid; gap: 10px; }
  .my-code { padding-top: 15px; border-top: 1px dashed var(--line-strong); }
  .my-code input { font: 12px var(--font-mono); }
  .list-top, .tabs { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .list-top { justify-content: space-between; margin-bottom: 18px; }
  .chosen, .chosen:hover { --btn-bg: var(--accent); --btn-ink: var(--paper); }
  .refresh, .remove { background: transparent; border: 0; text-decoration: underline; color: var(--accent); padding: 8px 0; }
  .entries { max-height: 380px; overflow: auto; }
  .person, .request { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--rule); padding: 12px 0; }
  .person strong, .request strong { flex: 1; overflow-wrap: anywhere; }
  .avatar { display: grid; place-items: center; width: 36px; height: 36px; background: var(--accent); color: var(--paper); rotate: -4deg; }
  .request div { display: flex; gap: 8px; }
  .outgoing { margin-top: 28px; }
  .empty { padding: 35px 0; }
  .duel-note { margin-top: 24px; padding: 18px; border: 1px dashed var(--line-strong); display: grid; gap: 10px; }
  .guide { display: flex; align-items: center; justify-content: center; gap: 15px; font: 700 23px/1 var(--font-hand); }
  .guest { display: grid; justify-items: center; gap: 16px; max-width: 580px; margin: 40px auto; text-align: center; }
  @media (min-width: 1100px) and (min-height: 521px) and (max-height: 850px) { .friends-page { padding-top: 4px; } header { margin-bottom: 18px; } .sheet { padding: 18px 22px; } .add { gap: 10px; } .guide { display: none; } .entries { max-height: 320px; } }
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) { .refresh, .remove { min-height: var(--tap); padding-inline: 4px; } }
  @media (max-width: 599px) { .address-book { grid-template-columns: 1fr; } header { flex-wrap: wrap; } .sheet { padding: 20px; } .request { flex-wrap: wrap; } .entries { max-height: none; } }
</style>
