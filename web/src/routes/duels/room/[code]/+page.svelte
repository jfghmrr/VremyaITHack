<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { account } from "#lib/api/account.svelte.ts";
  import { signInHref } from "#lib/auth/return.ts";
  import { command, connect, live } from "#lib/live/client.svelte.ts";

  const code = $derived((page.params.code ?? "").toUpperCase());
  let error = $state("");
  let joined = false;
  // Уведомление о новой комнате ещё не означает, что приглашённый игрок вошёл в неё.
  const attached = $derived(live.match?.room_code === code && !["finished", "cancelled", "failed"].includes(live.match.state) && live.match.players.some(p => p.user_id === account.profile?.id) ? live.match : null);

  $effect(() => {
    if (!account.profile || joined) return;
    joined = true;
    connect();
    if (attached) return void goto(`/duels/match/${attached.match_id}`, { replaceState: true });
    command({ type: "room_join", code }).then((r) => {
      if (!r.ok) error = r.error ?? "Не удалось войти в комнату.";
    });
  });
  $effect(() => {
    if (!attached || error) return;
    // Принятое приглашение на реванш больше не показывается.
    if (live.room?.invite && live.room.match_id === attached.match_id) live.room = null;
    void goto(`/duels/match/${attached.match_id}`, { replaceState: true });
  });
</script>

<svelte:head><title>Комната {code} — Перепев</title></svelte:head>

<section class="room">
  <h1>Комната <span class="mono">{code}</span></h1>
  {#if account.loaded && !account.profile}
    <p class="notice">Чтобы спеть с другом вживую, войди в кабинет. <a class="btn" href={signInHref(page.url.pathname)}>Войти</a></p>
  {:else if error}
    <p class="notice error" role="alert">{error}</p>
    <a class="btn" href="/duels">К дуэлям</a>
  {:else}
    <p class="muted" role="status">Подключаемся к комнате…</p>
  {/if}
  {#if !error}<a class="btn" href="/duels">← К дуэлям</a>{/if}
</section>

<style>
  .room {
    display: grid;
    gap: var(--s-4);
    justify-items: start;
    padding-top: var(--s-8);
  }
  h1 {
    padding: 4px var(--s-5) 8px;
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: 2.4rem;
    letter-spacing: 0;
    transform: rotate(-1.5deg);
  }
  h1 .mono {
    font-size: 0.7em;
    letter-spacing: 0.12em;
  }
</style>
