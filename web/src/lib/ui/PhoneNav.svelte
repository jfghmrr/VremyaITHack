<script lang="ts">
  // Нижнее меню телефона и лист «Меню» (PHONE_QUERY; на остальных раскладках скрыты). Шапка,
  // отступ страницы под меню (--bar-space) и распознавание экранной клавиатуры — в
  // routes/+layout.svelte; здесь пункты меню, лист и его шаги в истории (lib/ui/menu-history.ts).
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { account } from "#lib/api/account.svelte.ts";
  import { menuHistory } from "#lib/ui/menu-history.ts";
  import { PHONE_QUERY } from "#lib/ui/stage.svelte.ts";

  /** Отмеченный пункт: «Меню» — на страницах разделов из листа (лидеры, друзья, прогресс, кабинет, документы). */
  let { tab }: { tab: "home" | "songs" | "duels" | "menu" | null } = $props();

  const more = [
    { href: "/leaders", label: "Лидеры", icon: "leaders" },
    { href: "/friends", label: "Друзья", icon: "friends" },
    { href: "/progress", label: "Мой прогресс", icon: "progress" },
  ] as const;
  const documentsNav = [
    ["/legal/terms", "Пользовательское соглашение"],
    ["/legal/privacy", "Политика обработки данных"],
    ["/legal/consent", "Согласие на обработку данных"],
    ["/legal/cookies", "Cookie"],
    ["/legal/music", "Музыка и лицензии"],
    ["/legal/contacts", "Контакты"],
  ] as const;
  // Меню разделов на телефоне (compact): лист со списком разделов вместо двух рядов ярлыков.
  // Открытие — неглубокая навигация (goto с shallow), поэтому «Назад» в браузере закрывает меню.
  // Модальный <dialog>: фокус уходит в лист, Esc и касание мимо листа закрывают его, страница под
  // ним недоступна; после закрытия фокус возвращается на кнопку «Меню».
  let menuButton = $state<HTMLButtonElement>();
  let menuDialog = $state<HTMLDialogElement>();
  const menuOpen = $derived(page.state.menu === true);
  // Порядок шагов в истории — lib/ui/menu-history.ts: закрытие идёт «Назад» ровно один раз.
  const menu = menuHistory({
    isOpen: () => page.state.menu === true,
    push: () => void goto("", { shallow: true, state: { menu: true } }),
    back: () => history.back(),
    replace: (href) => goto(href, { replace: true }),
  });
  const openMenu = () => menu.open();
  const closeMenu = () => menu.close();
  // Поворот телефона или более широкое окно: шапка снова с вкладками, меню закрывается.
  // Запрос совпадает с CSS шапки ниже.
  onMount(() => {
    const narrow = matchMedia(PHONE_QUERY);
    const onChange = () => {
      if (!narrow.matches) closeMenu();
    };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  });
  $effect(() => {
    const d = menuDialog;
    if (!d) return;
    if (menuOpen && !d.open) {
      d.showModal();
      // Фокус на самом листе: при касании крестик не загорается рамкой фокуса, Tab ведёт к нему первым.
      d.querySelector<HTMLElement>(".menu-sheet")?.focus({ preventScroll: true });
    }
    else if (!menuOpen) {
      menu.closed();
      if (d.open) {
        // После перехода из меню фокус ставит сама навигация (начало новой страницы).
        const returnFocus = !menu.leaving;
        d.close();
        if (returnFocus) menuButton?.focus({ preventScroll: true });
      }
    }
  });
  // Переход из меню заменяет запись «меню открыто»: «Назад» с новой страницы ведёт на прежнюю
  // страницу без открытого меню. Ссылка на текущую страницу просто закрывает меню. Лист
  // закрывается, когда переход состоялся (page.state.menu пуст); если переход отменили или он
  // не удался, меню остаётся открытым, а закрытый браузером лист закрывается и в истории.
  async function menuLink(e: MouseEvent, href: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (href === page.url.pathname) return closeMenu();
    await menu.follow(href);
    if (page.state.menu === true && menuDialog && !menuDialog.open) closeMenu();
  }
  // «Поиск песни» из меню: как лупа в шапке — песни сверху, курсор в поле поиска.
  async function menuSearch(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    await menu.follow("/songs#search");
    if (page.state.menu === true) {
      if (menuDialog && !menuDialog.open) closeMenu();
      return;
    }
    scrollTo({ top: 0, left: 0 });
    document.querySelector<HTMLInputElement>("#search")?.focus({ preventScroll: true });
  }
</script>

<!-- Лист меню (только на телефоне): остальные разделы, поиск, кабинет и документы. Касание мимо
     листа (и по затемнённому нижнему меню) попадает в сам <dialog> и закрывает меню. -->
<dialog id="site-menu" class="menu" aria-label="Меню" bind:this={menuDialog}
  oncancel={(e) => { e.preventDefault(); closeMenu(); }}
  onclose={() => closeMenu()}
  onclick={(e) => { if (e.target === menuDialog) closeMenu(); }}>
  <div class="menu-sheet" tabindex="-1">
    <div class="menu-head">
      <span class="menu-title">Меню</span>
      <button class="menu-close" type="button" aria-label="Закрыть меню" onclick={closeMenu}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 6.1l11.7 11.8M17.9 6.2 6.1 17.9" /></svg>
      </button>
    </div>
    <a class="menu-row menu-search" href="/songs#search" onclick={menuSearch}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.4" r="6.1" /><path d="M15 15.1l5 4.9" /></svg>
      <span>Поиск песни</span>
    </a>
    <nav aria-label="Разделы">
      {#each more as item (item.href)}
        <a class="menu-row" href={item.href} aria-current={page.url.pathname.startsWith(item.href) ? "page" : undefined} onclick={(e) => menuLink(e, item.href)}>
          {#if item.icon === "leaders"}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.4 5 5.4.6-4 3.8 1.1 5.4L12 15.7l-4.8 2.7 1-5.4-4-3.8 5.5-.6z" /></svg>
          {:else if item.icon === "friends"}
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.6" r="3.1" /><path d="M3.4 19.2c.9-3 2.9-4.6 5.6-4.6s4.7 1.6 5.6 4.6" /><path d="M15.6 5.9a3 3 0 0 1 .4 5.9M17.4 14.7c1.7.5 2.8 2 3.3 4.4" /></svg>
          {:else}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20.2h16.2" /><path d="M6.2 19.8v-4.6M10.1 19.8v-7.5M14 19.8V9.6M17.9 19.8V5.2" /></svg>
          {/if}
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>
    <a class="menu-row menu-account" href="/account" aria-current={page.url.pathname.startsWith("/account") ? "page" : undefined} onclick={(e) => menuLink(e, "/account")}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6" /><path d="M5.5 19.5c1.2-3.3 3.6-5 6.5-5s5.3 1.7 6.5 5" /></svg>
      <span>{account.profile ? `Кабинет: ${account.profile.name}` : "Войти или зарегистрироваться"}</span>
    </a>
    <nav class="menu-docs" aria-label="Документы">
      {#each documentsNav as [href, label] (href)}
        <a {href} aria-current={page.url.pathname === href ? "page" : undefined} onclick={(e) => menuLink(e, href)}>{label}</a>
      {/each}
    </nav>
  </div>
</dialog>
<!-- Нижнее меню телефона (на остальных раскладках скрыто). Иконки нарисованы от руки, текущий
     пункт — жирная подпись с красной чертой. Во время пения и тренировки скрыто. -->
<nav class="tabbar" aria-label="Основная навигация">
  <a href="/" aria-current={tab === "home" ? "page" : undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M6.1 10.6v9.3h4.1v-5.1h3.7v5.1h4V10.5L12 5.2z" /><path d="M3.6 11.8 12 4.4l8.5 7.4M6.1 10.6v9.3h4.1v-5.1h3.7v5.1h4V10.5" /></svg>
    <span class="tab-label">Главная</span>
  </a>
  <a href="/songs" aria-current={tab === "songs" ? "page" : undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 17.6V6.3l10-2.1v11.1" /><ellipse class="fill" cx="6.9" cy="17.7" rx="2.6" ry="2.1" /><ellipse class="fill" cx="16.9" cy="15.3" rx="2.6" ry="2.1" /><path d="M9.2 9.4l10-2.1" /></svg>
    <span class="tab-label">Песни</span>
  </a>
  <a href="/duels" aria-current={tab === "duels" ? "page" : undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="6.9" cy="6.8" r="3.1" /><circle class="fill" cx="17.1" cy="6.8" r="3.1" /><path d="M9.1 9.1l10.4 10.6M14.9 9.1 4.5 19.7M5 5.4l3.8 3.7M19 5.4l-3.8 3.7" /></svg>
    <span class="tab-label">Дуэли</span>
  </a>
  <button type="button" class:current={tab === "menu" || menuOpen} aria-current={tab === "menu" ? "true" : undefined} aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="site-menu" bind:this={menuButton} onclick={openMenu}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 7.1h15.7M4 12.1h16M4.3 17h15.6" /></svg>
    <span class="tab-label">Меню</span>
  </button>
</nav>

<style>
  .tabbar {
    display: none;
  }
  /* Нижнее меню (только PHONE_QUERY): высота пункта --tabbar-h (60 px) плюс полоска «домой». */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .tabbar {
      position: fixed;
      z-index: 40;
      left: 0;
      right: 0;
      bottom: 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      height: calc(var(--tabbar-h) + var(--safe-bottom));
      padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
      background: var(--paper-2) var(--tex-paper);
      color: var(--ink);
      box-shadow:
        0 -1px 0 rgb(0 0 0 / 0.35),
        0 -12px 24px -14px rgb(0 0 0 / 0.8);
    }
    :global(.shell.bare) .tabbar,
    :global(.shell.keyboard) .tabbar {
      display: none;
    }
    .tabbar a,
    .tabbar button {
      display: grid;
      justify-items: center;
      align-content: center;
      gap: 3px;
      min-width: 0;
      min-height: var(--tabbar-h);
      padding: 6px 2px 4px;
      border: 0;
      background: none;
      color: var(--ink-2);
      font: 500 0.75rem/1.1 var(--font);
      text-decoration: none;
      -webkit-tap-highlight-color: transparent;
    }
    .tabbar :focus-visible {
      outline-offset: -4px;
    }
    .tabbar svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .tabbar .fill {
      fill: none;
    }
    .tab-label {
      position: relative;
      padding-bottom: 5px;
    }
    /* Текущий пункт: чернила, жирная подпись, короткая красная черта от руки под ней. */
    .tabbar [aria-current="page"],
    .tabbar .current {
      color: var(--ink);
      font-weight: 700;
    }
    .tabbar [aria-current="page"] svg,
    .tabbar .current svg {
      stroke-width: 2.2;
    }
    .tabbar [aria-current="page"] .fill {
      fill: currentColor;
    }
    .tabbar [aria-current="page"] .tab-label::after,
    .tabbar .current .tab-label::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: 0;
      width: 30px;
      height: 3px;
      border-radius: 2px;
      background: var(--accent);
      translate: -50% 0;
      rotate: -1.5deg;
    }
  }

  /* Лист «Меню»: бумага с рваным верхним краем над нижним меню; поля учитывают
     вырез экрана. Нижнее меню под затемнением видно, касание по нему закрывает лист. */
  .menu {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    overflow: hidden;
    opacity: 0;
    transition:
      opacity var(--d-base) var(--ease),
      display var(--d-base) allow-discrete,
      overlay var(--d-base) allow-discrete;
  }
  .menu[open] {
    opacity: 1;
  }
  /* Пока закрытый лист гаснет, касания проходят на страницу. */
  .menu:not([open]) {
    pointer-events: none;
  }
  .menu::backdrop {
    background: rgb(8 8 10 / 0.62);
  }
  .menu-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--tabbar-h, 0px) + var(--safe-bottom));
    max-height: calc(100% - var(--tabbar-h, 0px) - var(--safe-bottom) - var(--safe-top) - var(--s-4));
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--s-5) calc(var(--gutter) + var(--safe-right)) var(--s-3) calc(var(--gutter) + var(--safe-left));
    background: var(--paper-2) var(--tex-paper);
    clip-path: polygon(0 6px, 16% 1px, 37% 5px, 59% 0, 82% 4px, 100% 1px, 100% 100%, 0 100%);
    box-shadow: inset 0 -1px 0 var(--line);
    transform-origin: 50% 100%;
    transition: scale var(--d-base) var(--ease);
  }
  .menu-sheet:focus {
    outline: none;
  }
  @starting-style {
    .menu[open] {
      opacity: 0;
    }
    /* Лист растёт от нижнего края: он ни на миг не заходит на нижнее меню, и касание по
       «Меню» во время появления закрывает лист, а не попадает в него. */
    .menu[open] .menu-sheet {
      scale: 1 0.94;
    }
  }
  .menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    margin-bottom: var(--s-2);
  }
  .menu-title {
    font: 700 1.8rem/1 var(--font-hand);
  }
  .menu-close {
    display: grid;
    place-items: center;
    width: var(--tap);
    height: var(--tap);
    border: 1.5px solid var(--ink);
    border-radius: 50%;
    background: transparent;
    color: var(--ink);
  }
  .menu svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* Строки тетради с иконкой; текущий раздел — красная полоска слева и красная иконка. */
  .menu nav:not(.menu-docs) {
    display: grid;
  }
  .menu-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: 52px;
    padding: 0 var(--s-2);
    border-bottom: 1px solid var(--rule);
    color: var(--ink);
    font-size: var(--t-l);
    font-weight: 600;
    text-decoration: none;
  }
  .menu-row svg {
    flex: none;
    color: var(--ink-2);
  }
  .menu-row[aria-current="page"] {
    box-shadow: inset 4px 0 0 var(--accent);
    color: var(--accent);
  }
  .menu-row[aria-current="page"] svg {
    color: var(--accent);
  }
  .menu-account {
    margin-top: var(--s-2);
    border: 1px dashed var(--line-strong);
    font-size: var(--t-m);
  }
  .menu-docs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 var(--s-3);
    margin-top: var(--s-3);
  }
  .menu-docs a {
    display: flex;
    align-items: center;
    min-height: var(--tap);
    color: var(--ink-2);
    font-size: var(--t-xs);
    line-height: 1.25;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
    text-underline-offset: 3px;
  }
  .menu-docs a[aria-current="page"] {
    color: var(--accent);
  }
  /* Пока меню открыто, страница под ним не прокручивается. */
  :global(html:has(#site-menu[open])) {
    overflow: hidden;
  }
</style>
