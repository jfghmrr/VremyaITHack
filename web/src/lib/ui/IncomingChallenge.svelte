<script lang="ts">
  // Вызов-призрак из ссылки #echo=…: записанная кривая друга, а не живой соперник.
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { decodeChallenge } from "#lib/challenge/codec.ts";
  import { incoming } from "#lib/session.svelte.ts";
  import { loadCatalog } from "#lib/catalog.ts";

  let title = $state("");

  function read() {
    // Якоря поиска и других разделов не являются приглашениями.
    if (!location.hash.startsWith("#echo=")) {
      incoming.error = "";
      return;
    }
    try {
      const c = decodeChallenge(location.hash);
      if (c) {
        incoming.challenge = c;
        incoming.error = "";
      }
    } catch (e) {
      incoming.challenge = null;
      incoming.error = (e as Error).message;
    }
  }

  onMount(() => {
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  });

  $effect(() => {
    const id = incoming.challenge?.songId;
    if (!id) return;
    loadCatalog()
      .then((list) => (title = list.find((s) => s.id === id)?.title ?? ""))
      .catch(() => {});
  });

  function dismiss() {
    incoming.challenge = null;
    incoming.error = "";
    history.replaceState(history.state, "", location.pathname + location.search);
  }
</script>

{#if incoming.challenge}
  <aside class="challenge" aria-label="Входящий вызов">
    <div class="ghost-line" aria-hidden="true"></div>
    <div class="text">
      <h2>{incoming.challenge.name} вызывает тебя спеть «{title || incoming.challenge.songId}»</h2>
      <p class="muted small">Это вызов-призрак: сохранённая линия пения без звука. Пой в своей тональности, обе попытки оценит одно ядро.</p>
    </div>
    {#if title}
      <button class="btn btn-primary" onclick={() => goto(`/sing/${incoming.challenge!.songId}`)}>Принять вызов</button>
    {:else}
      <p class="small" role="status">Этой песни нет в каталоге: вызов создан для другой версии сайта.</p>
    {/if}
    <button class="btn btn-quiet" onclick={dismiss}>Без дуэли</button>
  </aside>
{:else if incoming.error}
  <p class="notice error" role="alert">
    {incoming.error}
    <button class="btn btn-quiet" onclick={dismiss}>Закрыть</button>
  </p>
{/if}

<style>
  /* Вызов — открытка с синим пунктиром призрака и маркой. */
  .challenge, .notice {
    position: fixed;
    z-index: 30;
    left: 50%;
    top: 76px;
    transform: translateX(-50%);
    width: min(1100px, calc(100% - 48px));
    box-shadow: 0 10px 45px #000a;
  }
  .challenge {
    --muted: var(--ink-2);
    display: grid;
    grid-template-columns: 44px 1fr auto auto;
    align-items: center;
    gap: var(--s-4);
    margin-top: var(--s-3);
    padding: var(--s-3) var(--s-5);
    background: var(--rival-soft) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-sheet);
    border-left: 6px dashed var(--rival);
  }
  .ghost-line {
    height: 3px;
    background: repeating-linear-gradient(90deg, var(--rival) 0 7px, transparent 7px 12px);
  }
  h2 {
    font-size: var(--t-l);
  }
  .text {
    display: grid;
    gap: var(--s-1);
  }
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .challenge, .notice { position: relative; top: auto; left: auto; transform: none; width: 100%; }
    .challenge {
      grid-template-columns: 1fr;
    }
    .ghost-line {
      display: none;
    }
  }
</style>
