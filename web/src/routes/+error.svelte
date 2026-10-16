<script lang="ts">
  // Страница ошибки в стиле комнаты: бумажная записка и смущённый кот. Навигация и
  // подвал остаются (страница рендерится внутри общего макета). Текст ошибки
  // фреймворка (англ. «Not Found» и т. п.) не показывается.
  import { page } from "$app/state";
  import Cat from "#lib/brand/Cat.svelte";
  import Asset from "#lib/brand/Asset.svelte";

  const missing = $derived(page.status === 404);
</script>

<svelte:head><title>{missing ? "Страница не найдена — Перепев" : "Ошибка — Перепев"}</title></svelte:head>

<section class="lost" aria-labelledby="error-title">
  <div class="card sheet">
    <span class="clip" aria-hidden="true"><Asset name="hardware/paperclip-s02" width={24} /></span>
    <span class="stamp mono" aria-hidden="true">{page.status}</span>
    <h1 id="error-title">{missing ? "Такой страницы нет" : "Что-то пошло не так"}</h1>
    <p>
      {missing
        ? "Возможно, ссылка устарела или в адресе опечатка. Кот заглянул во все шкафчики — здесь пусто."
        : "Страница не открылась. Обычно помогает обновить её, а если нет — загляни чуть позже."}
    </p>
    <div class="actions">
      {#if missing}
        <a class="btn btn-primary" href="/">На главную</a>
        <a class="btn" href="/songs">К песням</a>
      {:else}
        <button class="btn btn-primary" type="button" onclick={() => location.reload()}>Попробовать ещё раз</button>
        <a class="btn" href="/">На главную</a>
      {/if}
    </div>
  </div>
  <div class="cat"><Cat mood="shy" size="100%" /></div>
</section>

<style>
  .lost {
    display: grid;
    grid-template-columns: minmax(0, 560px) minmax(160px, 300px);
    justify-content: center;
    align-items: center;
    gap: clamp(24px, 5vw, 80px);
    min-height: calc(100svh - var(--chrome));
    padding: var(--s-6) 0;
  }
  .card {
    display: grid;
    justify-items: start;
    gap: var(--s-4);
    padding: var(--s-7) var(--s-6) var(--s-6);
    rotate: -0.6deg;
  }
  .clip {
    position: absolute;
    left: 28px;
    top: -20px;
    rotate: -8deg;
  }
  /* Штамп с кодом ошибки: рамка и наклон, как у причин в разборе. */
  .stamp {
    position: absolute;
    right: 22px;
    top: 18px;
    padding: 0 10px;
    border: 2px solid var(--accent);
    border-radius: 2px;
    color: var(--accent);
    font-size: var(--t-l);
    rotate: 8deg;
  }
  h1 {
    padding-right: 3.2em;
    font: 700 clamp(2.1rem, 3.6vw, 3.2rem) / 1.05 var(--font-hand);
    letter-spacing: 0;
  }
  p {
    max-width: 46ch;
    color: var(--ink-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin-top: var(--s-2);
  }
  .cat {
    justify-self: center;
    width: 100%;
    max-width: 300px;
  }
  /* compact: телефон в портрете — кот над запиской, без пустого экрана. */
  @media (max-width: 599px) {
    .lost {
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      min-height: 0;
      padding-top: var(--s-4);
    }
    .cat {
      order: -1;
      max-width: 150px;
    }
    .card {
      padding: var(--s-6) var(--s-5) var(--s-5);
    }
  }
  /* short: телефон в ландшафте — записка и кот рядом, кот меньше. */
  @media (max-height: 520px) and (orientation: landscape) {
    .lost {
      grid-template-columns: minmax(0, 520px) 150px;
      min-height: 0;
      padding: var(--s-4) 0;
    }
  }
</style>
