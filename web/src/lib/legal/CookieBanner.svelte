<script lang="ts">
  // Уведомление о cookie и хранилище браузера. Сайт использует только необходимые записи,
  // поэтому выбор категорий не нужен; согласие запоминается в localStorage.
  import { onMount } from "svelte";
  const KEY = "perepev.cookies";
  let show = $state(false);
  onMount(() => {
    try {
      show = !localStorage.getItem(KEY);
    } catch {
      show = true;
    }
  });
  function accept() {
    try {
      localStorage.setItem(KEY, new Date().toISOString());
    } catch {
      /* без хранилища плашка вернётся при следующем визите */
    }
    show = false;
  }
</script>

{#if show}
  <div class="banner" role="region" aria-label="Уведомление о cookie">
    <p>
      Мы используем только необходимые cookie и хранилище браузера: для входа в кабинет и сохранения настроек. Рекламы и аналитики нет.
      <a href="/legal/cookies">Подробнее</a>, <a href="/legal/privacy">политика обработки данных</a>.
    </p>
    <button class="btn btn-ink accept" onclick={accept}>Принимаю</button>
  </div>
{/if}

<style>
  /* wide: записка на скотче у нижнего края, по центру между вырезами экрана. */
  .banner {
    position: fixed;
    left: calc(50% + (var(--safe-left) - var(--safe-right)) / 2);
    bottom: calc(var(--s-4) + var(--safe-bottom));
    z-index: 50;
    transform: translateX(-50%) rotate(-0.4deg);
    display: flex;
    align-items: center;
    gap: var(--s-5);
    width: min(calc(100% - 2 * var(--s-4) - var(--safe-left) - var(--safe-right)), 880px);
    padding: var(--s-4) var(--s-4) var(--s-4) var(--s-5);
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-pop);
    font-size: var(--t-s);
  }
  .banner::before {
    content: "";
    position: absolute;
    left: 50%;
    top: -12px;
    width: 96px;
    height: 24px;
    background: rgb(232 226 205 / 0.55);
    transform: translateX(-50%) rotate(2deg);
    box-shadow: 0 1px 1px rgb(0 0 0 / 0.12);
  }
  /* Ссылка не переносится: рамка ссылки в две строки накрыла бы соседнюю. */
  a {
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
  }
  .accept {
    flex: none;
  }
  /* Не wide (телефон, планшет): в потоке шапки под вкладками — не закрывает «Начать пение»
     и другие главные действия, а поля вырезов экрана уже учтены у шапки. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .banner {
      position: static;
      flex: 1 1 100%;
      transform: none;
      width: auto;
      gap: var(--s-3);
      padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
      font-size: var(--t-xs);
      line-height: 1.35;
      box-shadow: var(--shadow-sheet);
    }
    .banner::before {
      display: none;
    }
  }
  /* compact: текст во всю ширину записки, кнопка под ним справа. */
  @media (max-width: 599px) {
    .banner {
      flex-direction: column;
      align-items: stretch;
      gap: var(--s-2);
    }
    .accept {
      align-self: flex-end;
    }
  }
</style>
