<script lang="ts">
  import "#lib/styles/tokens.css";
  import "#lib/styles/base.css";
  import { page } from "$app/state";
  import { afterNavigate, goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { account, refreshAccount } from "#lib/api/account.svelte.ts";
  import { PHONE_QUERY, stage } from "#lib/ui/stage.svelte.ts";
  import AchievementToast from "#lib/ui/AchievementToast.svelte";
  import CursorSparkles from "#lib/ui/CursorSparkles.svelte";
  import { refreshAchievements, updateAchievements } from "#lib/achievements.svelte.ts";
  import { guestAttempts } from "#lib/history.svelte.ts";
  import CookieBanner from "#lib/legal/CookieBanner.svelte";
  import { legalNavigation } from "#lib/legal/navigation.svelte.ts";
  import Wall from "#lib/brand/Wall.svelte";
  import PhoneNav from "#lib/ui/PhoneNav.svelte";
  import AgeBadge from "#lib/legal/AgeBadge.svelte";

  let { children } = $props();
  onMount(() => { updateAchievements(guestAttempts(), [], false); void refreshAccount(); });
  $effect(() => { const id = account.profile?.id; if (id) void refreshAchievements(false); });

  const songsPath = (p: string) => p.startsWith("/songs") || p.startsWith("/sing") || p.startsWith("/result") || p.startsWith("/practice") || p.startsWith("/tracks");
  // Телефон (PHONE_QUERY): нижнее меню из четырёх пунктов. «Меню» открывает остальные разделы,
  // поиск, кабинет и документы; оно отмечено на страницах этих разделов.
  const menuPath = (p: string) => /^\/(leaders|friends|progress|account|legal)(\/|$)/.test(p);
  const tab = $derived.by(() => {
    const p = page.url.pathname;
    return p === "/" ? "home" : songsPath(p) ? "songs" : p.startsWith("/duels") ? "duels" : menuPath(p) ? "menu" : null;
  });
  // Шапка телефона: стрелка к родительскому экрану, логотип и одна-две круглые кнопки (поиск,
  // кабинет). На экранах одного действия (пение, итог, тренировка, матч, редактор) кнопок нет.
  const phoneHead = $derived.by(() => {
    const p = page.url.pathname;
    const back = (href: string, label: string) => ({ href, label: `Назад: ${label}` });
    if (p === "/") return { back: null, search: true, account: true };
    if (p === "/songs") return { back: back("/", "главная"), search: true, account: false };
    if (p.startsWith("/sing/") || p === "/result") return { back: back("/songs", "выбор песни"), search: false, account: false };
    if (p === "/practice") return { back: back("/result", "разбор"), search: false, account: false };
    if (p.startsWith("/tracks/")) return { back: back("/songs#my-tracks", "мои треки"), search: false, account: false };
    if (p === "/duels") return { back: back("/", "главная"), search: true, account: true };
    if (p.startsWith("/duels/")) return { back: back("/duels", "дуэли"), search: false, account: false };
    if (p.startsWith("/legal")) return { back: back(legalNavigation.returnTo || "/", "к сайту"), search: true, account: true };
    if (p === "/account") return { back: back("/", "главная"), search: true, account: false };
    return { back: back("/", "главная"), search: true, account: true };
  });
  // Во время пения и тренировки нижнее меню скрыто: не отнимает высоту и не ловит касания.
  const bare = $derived(stage.focus || stage.live);
  // Открыта экранная клавиатура: в фокусе поле для текста и видимая область окна заметно ниже
  // полной высоты (visualViewport; при клавиатуре, которая сжимает и сам макет, — ниже самой
  // высокой замеренной при той же ширине). Только фокус не в счёт: фокус из кода (лупа, «Поиск
  // песни» из меню, возврат на /songs#search) клавиатуру не открывает, и меню остаётся на месте.
  let keyboard = $state(false);
  const NOT_TEXT = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image", "hidden"]);
  const typingInto = (el: Element | null) =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
  onMount(() => {
    const phone = matchMedia(PHONE_QUERY);
    const vv = window.visualViewport;
    let width = 0;
    let tallest = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const visible = vv ? vv.height * vv.scale : innerHeight;
      if (innerWidth !== width) {
        width = innerWidth;
        tallest = 0;
      }
      tallest = Math.max(tallest, visible);
      const full = Math.max(tallest, document.documentElement.clientHeight);
      keyboard = phone.matches && typingInto(document.activeElement) && full - visible > 150;
    };
    // focusout приходит раньше, чем меняется activeElement: замер — в следующем кадре.
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    vv?.addEventListener("resize", later);
    addEventListener("resize", later);
    addEventListener("focusin", later);
    addEventListener("focusout", later);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", later);
      removeEventListener("resize", later);
      removeEventListener("focusin", later);
      removeEventListener("focusout", later);
    };
  });
  const nav = [
    { href: "/", label: "Главная", match: (p: string) => p === "/" },
    { href: "/songs", label: "Песни", match: songsPath },
    { href: "/duels", label: "Дуэли", match: (p: string) => p.startsWith("/duels") },
    { href: "/leaders", label: "Лидеры", match: (p: string) => p.startsWith("/leaders") },
    { href: "/friends", label: "Друзья", match: (p: string) => p.startsWith("/friends") },
    { href: "/progress", label: "Мой прогресс", match: (p: string) => p.startsWith("/progress") },
  ];
  // Лупа: страница песен открывается сверху, курсор — в поле поиска. Обычный переход по
  // /songs#search прокручивал страницу к полю с id="search" (так SvelteKit обрабатывает #hash),
  // и шапка с вкладками уезжала за край окна (правка владельца, скрин 2).
  async function openSearch(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    await goto("/songs#search", { reset: false });
    scrollTo({ top: 0, left: 0 });
    document.querySelector<HTMLInputElement>("#search")?.focus({ preventScroll: true });
  }
  const scene = $derived(page.url.pathname.startsWith("/sing") ? (stage.focus ? "sing" : "mic") : page.url.pathname.split("/")[1] || "home");
  let docsOpen = $state(false);
  let lastPath = "";
  afterNavigate((nav) => {
    if (!nav.shallow) docsOpen = false;
    if (lastPath !== page.url.pathname && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelector("main")?.animate([{ opacity: .35, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 200, easing: "ease-out" });
    }
    if (!page.url.pathname.startsWith("/legal")) legalNavigation.returnTo = page.url.pathname + page.url.search;
    lastPath = page.url.pathname;
  });
</script>

<Wall {scene} />
<CursorSparkles />
<AchievementToast />

<div class="shell" class:on-stage={stage.dark} class:focus={stage.focus} class:bare class:keyboard>
  <a class="skip" href="#main">К содержимому</a>
  {#if !stage.focus}
    <header class="top">
      <!-- Телефон: стрелка к родительскому экрану (на остальных раскладках её нет). -->
      {#if phoneHead.back}
        <a class="back-link" href={phoneHead.back.href} aria-label={phoneHead.back.label}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12.2H5.2M11 6.1l-6.1 6.1 6.2 6" /></svg>
        </a>
      {/if}
      <!-- Телефон: логотип ведёт на главную, разделы — в нижнем меню. -->
      <a class="brand" href="/" aria-current={page.url.pathname === "/" ? "page" : undefined}><span class="brand-word">Перепев</span></a>
      <nav aria-label="Основная навигация">
        {#each nav as item (item.href)}
          <a href={item.href} aria-current={item.match(page.url.pathname) ? "page" : undefined}>{item.label}</a>
        {/each}
      </nav>
      <div class="icons">
        <a class="icon" class:phone-off={!phoneHead.search} href="/songs#search" aria-label="Поиск песни" onclick={openSearch}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>
        </a>
        <a class="icon who" class:phone-off={!phoneHead.account} href="/account" aria-current={page.url.pathname.startsWith("/account") ? "page" : undefined} aria-label={account.profile ? `Настройки аккаунта: ${account.profile.name}` : "Войти"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6" /><path d="M5.5 19.5c1.2-3.3 3.6-5 6.5-5s5.3 1.7 6.5 5" /></svg>
        </a>
        {#if account.profile}<span class="name">{account.profile.name}</span>{/if}
      </div>
      <!-- На телефоне и планшете уведомление стоит в шапке под вкладками и ничего не закрывает;
           на широком экране это записка у нижнего края. -->
      <CookieBanner />
    </header>
  {/if}
  <main id="main" tabindex="-1">
    {@render children()}
  </main>
  {#if !stage.focus}
    <footer class="foot">
      <span>© 2026 Перепев</span>
      <AgeBadge age="6+" size="m" />
      <!-- compact: шесть ссылок на документы свёрнуты за одной кнопкой (на телефоне они занимали
           четыре неровных ряда в конце каждой страницы). На широких экранах кнопки нет. -->
      <button class="docs-toggle" type="button" aria-expanded={docsOpen} aria-controls="foot-docs" onclick={() => (docsOpen = !docsOpen)}>
        Документы
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={docsOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} /></svg>
      </button>
      <nav id="foot-docs" aria-label="Документы" class:collapsed={!docsOpen}>
        <a href="/legal/terms">Пользовательское соглашение</a>
        <a href="/legal/privacy">Политика обработки данных</a>
        <a href="/legal/consent">Согласие на обработку данных</a>
        <a href="/legal/cookies">Cookie</a>
        <a href="/legal/music">Музыка и лицензии</a>
        <a href="/legal/contacts">Контакты</a>
      </nav>
    </footer>
  {/if}
  <PhoneNav {tab} />
</div>

<style>
  /* Безопасные поля телефона: вырез и скругления слева/справа, статус-бар сверху,
     полоска «домой» снизу. Фон комнаты (Wall) остаётся под ними. */
  .shell {
    min-height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    padding: 0 var(--safe-right) 0 var(--safe-left);
  }
  .focus main {
    padding-top: var(--safe-top);
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--s-5);
    width: min(100%, var(--container));
    margin: 0 auto;
    padding: calc(var(--s-3) + var(--safe-top)) var(--gutter) var(--s-2);
  }
  /* Навигация — бумажные ярлыки. Текущий раздел: вишнёвый ярлык, приклеен ровно, с подчёркиванием от руки. */
  .top nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .top nav a {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 38px;
    z-index: 0;
    padding: 0 var(--s-4) 2px;
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: 1.4rem;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    transition: transform var(--d-fast) var(--ease);
  }
  /* Бумага ярлыка — на ::before: рваный край не обрезает контур фокуса. */
  .top nav a::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--tab-bg, var(--paper)) var(--tex-paper);
    clip-path: polygon(0 6%, 50% 0, 100% 5%, 98% 50%, 100% 94%, 50% 100%, 1% 96%, 2% 50%);
  }
  .top nav a:nth-child(odd) {
    transform: rotate(-1.2deg);
  }
  .top nav a:nth-child(even) {
    transform: rotate(1deg) translateY(1px);
  }
  .top nav a:hover {
    --tab-bg: var(--paper-2);
    transform: translateY(-2px) rotate(0);
  }
  .top nav a[aria-current="page"] {
    --tab-bg: var(--accent);
    color: var(--paper-2);
    transform: none;
    text-decoration: underline wavy;
    text-decoration-thickness: 1.5px;
    text-underline-offset: 5px;
  }
  .icons {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  /* Логотип и стрелка «назад» — только на телефоне (PHONE_QUERY); нижнее меню — PhoneNav.svelte. */
  .brand,
  .back-link {
    display: none;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border: 2px solid var(--on-room-2);
    border-radius: 50%;
    background: #111012;
    color: var(--on-room);
    transition: border-color var(--d-fast) var(--ease);
  }
  .icon:hover {
    border-color: var(--on-room);
  }
  .icon svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  /* wide: имя справа от значка не сдвигает вкладки — вошедший и гость видят меню на одном месте (QA L19). */
  @media (min-width: 1100px) {
    .icons {
      position: relative;
    }
    .name {
      position: absolute;
      left: calc(100% + var(--s-2));
    }
  }
  .name {
    font-size: var(--t-s);
    color: var(--on-room-2);
    max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* «К содержимому»: первая остановка Tab, видна только в фокусе (QA L27). Без фокуса она
     не только за краем окна, но и прозрачна и не принимает касаний: это не видимая цель нажатия. */
  .skip {
    position: fixed;
    z-index: 2000;
    left: calc(var(--s-4) + var(--safe-left));
    top: calc(var(--s-2) + var(--safe-top));
    display: inline-flex;
    align-items: center;
    padding: var(--s-2) var(--s-4);
    background: var(--paper);
    color: var(--ink);
    font-weight: 700;
    translate: 0 -200%;
    opacity: 0;
    pointer-events: none;
  }
  .skip:focus {
    translate: 0 0;
    opacity: 1;
    pointer-events: auto;
  }
  main:focus {
    outline: none;
  }
  main {
    min-width: 0;
    width: min(100%, var(--container));
    margin: 0 auto;
    padding: 0 var(--gutter) var(--s-4);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: var(--s-5);
    width: min(100%, var(--container));
    margin: 0 auto;
    padding: var(--s-2) var(--gutter) calc(var(--s-3) + var(--safe-bottom));
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--on-room-3);
  }
  .foot nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-4);
    margin-right: auto;
  }
  .foot a {
    color: inherit;
    text-decoration: none;
  }
  .foot a:hover {
    color: var(--on-room);
    text-decoration: underline;
  }
  .docs-toggle {
    display: none;
  }
  @media (max-width: 599px), (max-height: 520px) and (orientation: landscape) {
    .top {
      align-items: flex-start;
    }
    .name {
      display: none;
    }
    .foot {
      flex-wrap: wrap;
    }
  }
  /* Сенсорные и небольшие экраны: вкладки, значки и ссылки подвала не ниже 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .top nav a,
    .skip {
      min-height: var(--tap);
    }
    .icon {
      width: var(--tap);
      height: var(--tap);
    }
    .foot {
      gap: 0 var(--s-5);
    }
    .foot nav {
      gap: 0 var(--s-4);
    }
    .foot a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: var(--tap);
      min-height: var(--tap);
    }
  }
  /* compact и short: компактные ярлыки, шапка не съедает экран телефона. */
  @media (max-width: 599px), (max-height: 520px) and (orientation: landscape) {
    .top {
      gap: var(--s-2) var(--s-3);
      padding-top: calc(var(--s-2) + var(--safe-top));
    }
    .top nav {
      gap: 6px;
    }
    .top nav a {
      padding: 0 10px 2px;
      font-size: 1.2rem;
    }
  }
  /* Телефон (PHONE_QUERY: портрет телефона и узкий планшет до 800 px; правка владельца
     18.10.2026 по макету). Шапка в одну строку: стрелка к родительскому экрану, логотип из
     вырезанных букв и одна-две круглые кнопки (поиск, кабинет). Разделы — в нижнем меню. */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-start;
      gap: var(--s-2) 6px;
      min-height: calc(60px + var(--safe-top));
      padding: calc(var(--s-2) + var(--safe-top)) var(--gutter) var(--s-2);
    }
    .top > :global(.banner) {
      flex-basis: 100%;
    }
    .top > nav {
      display: none;
    }
    .back-link {
      display: grid;
      place-items: center;
      flex: none;
      width: var(--tap);
      height: var(--tap);
      margin-left: -10px;
      color: var(--on-room);
    }
    .back-link svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    /* Логотип — та же вырезка, что на главной (branding/logo-main-s01, 1600×419, здесь 150×39 в
       ссылке высотой 44 px). Фоном, а не <img>: на остальных раскладках файл не скачивается,
       место под него задано заранее. */
    .brand {
      display: block;
      flex: none;
      width: 150px;
      height: var(--tap);
      background: url("/art/branding/logo-main-s01.webp?v=web-1") left center / 150px auto no-repeat;
      filter: drop-shadow(0 3px 3px rgb(0 0 0 / 0.55));
    }
    .brand-word {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .icons {
      gap: var(--s-2);
      margin-left: auto;
    }
    .icon {
      border: 1.5px solid var(--on-room);
      background: transparent;
    }
    .icon svg {
      width: 22px;
      height: 22px;
      stroke-width: 1.9;
    }
    .icon.phone-off,
    .name {
      display: none;
    }
  }
  /* compact: подвал крупнее. Уведомление о cookie во всю ширину шапки (QA L3) — в блоке выше. */
  @media (max-width: 599px) {
    .foot {
      font-size: 0.8125rem;
    }
    .docs-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: var(--tap);
      padding: 0 var(--s-2);
      border: 0;
      background: none;
      color: var(--on-room-2);
      font: inherit;
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
      text-underline-offset: 3px;
    }
    .docs-toggle svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .foot nav.collapsed {
      display: none;
    }
    /* Раскрытый список — ровная колонка, а не рваные ряды. */
    .foot nav {
      flex-direction: column;
      align-items: flex-start;
      flex-basis: 100%;
    }
    .foot nav a {
      justify-content: flex-start;
    }
  }

  /* Нижнее меню и лист «Меню» (только PHONE_QUERY). Высота пункта 60 px плюс полоска «домой»;
     содержимое страницы и прилипающие панели (кнопка «Петь» на песнях, лист «Поделиться»,
     достижения) отступают на --bar-space. Во время пения и тренировки (.bare) меню скрыто;
     пока открыта экранная клавиатура (.keyboard), тоже — оно не закрывает поле. */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px) {
    :global(:root) {
      --tabbar-h: 60px;
      --bar-space: calc(var(--tabbar-h) + var(--safe-bottom));
    }
    :global(:root:has(.shell.bare)),
    :global(:root:has(.shell.keyboard)) {
      --bar-space: 0px;
    }
    /* Прокрутка к элементу (фокус с клавиатуры, якорь, scrollIntoView) оставляет его над меню. */
    :global(html) {
      scroll-padding-bottom: calc(var(--bar-space) + var(--s-2));
    }
    /* Отступ страницы под меню и отступ прилипающих панелей — одна величина: когда меню скрыто
       (пение, тренировка, открытая клавиатура), исчезают оба. */
    .shell {
      padding-bottom: var(--bar-space);
    }
    .shell:not(.bare) .foot {
      padding-bottom: var(--s-3);
    }
  }

</style>
