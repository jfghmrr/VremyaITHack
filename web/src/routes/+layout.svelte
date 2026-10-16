<script lang="ts">
  import "#lib/styles/tokens.css";
  import "#lib/styles/base.css";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import { onMount } from "svelte";
  import { account, refreshAccount } from "#lib/api/account.svelte.ts";
  import { stage } from "#lib/ui/stage.svelte.ts";
  import AchievementToast from "#lib/ui/AchievementToast.svelte";
  import CursorSparkles from "#lib/ui/CursorSparkles.svelte";
  import { refreshAchievements, updateAchievements } from "#lib/achievements.svelte.ts";
  import { guestAttempts } from "#lib/history.svelte.ts";
  import CookieBanner from "#lib/legal/CookieBanner.svelte";
  import { legalNavigation } from "#lib/legal/navigation.svelte.ts";
  import Wall from "#lib/brand/Wall.svelte";
  import AgeBadge from "#lib/legal/AgeBadge.svelte";

  let { children } = $props();
  onMount(() => { updateAchievements(guestAttempts(), [], false); void refreshAccount(); });
  $effect(() => { const id = account.profile?.id; if (id) void refreshAchievements(false); });

  const songsPath = (p: string) => p.startsWith("/songs") || p.startsWith("/sing") || p.startsWith("/result") || p.startsWith("/practice");
  const nav = [
    { href: "/", label: "Главная", match: (p: string) => p === "/" },
    { href: "/songs", label: "Песни", match: songsPath },
    { href: "/duels", label: "Дуэли", match: (p: string) => p.startsWith("/duels") },
    { href: "/leaders", label: "Лидеры", match: (p: string) => p.startsWith("/leaders") },
    { href: "/friends", label: "Друзья", match: (p: string) => p.startsWith("/friends") },
    { href: "/progress", label: "Мой прогресс", match: (p: string) => p.startsWith("/progress") },
  ];
  const scene = $derived(page.url.pathname.startsWith("/sing") ? (stage.focus ? "sing" : "mic") : page.url.pathname.split("/")[1] || "home");
  let lastPath = "";
  afterNavigate(() => {
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

<div class="shell" class:on-stage={stage.dark} class:focus={stage.focus}>
  {#if !stage.focus}
    <header class="top">
      <nav aria-label="Основная навигация">
        {#each nav as item (item.href)}
          <a href={item.href} aria-current={item.match(page.url.pathname) ? "page" : undefined}>{item.label}</a>
        {/each}
      </nav>
      <div class="icons">
        <a class="icon" href="/songs#search" aria-label="Поиск песни">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>
        </a>
        <a class="icon who" href="/account" aria-label={account.profile ? `Настройки аккаунта: ${account.profile.name}` : "Войти"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6" /><path d="M5.5 19.5c1.2-3.3 3.6-5 6.5-5s5.3 1.7 6.5 5" /></svg>
        </a>
        {#if account.profile}<span class="name">{account.profile.name}</span>{/if}
      </div>
      <!-- На телефоне и планшете уведомление стоит в шапке под вкладками и ничего не закрывает;
           на широком экране это записка у нижнего края. -->
      <CookieBanner />
    </header>
  {/if}
  <main>
    {@render children()}
  </main>
  {#if !stage.focus}
    <footer class="foot">
      <span>© 2026 Перепев</span>
      <AgeBadge age="6+" size="m" />
      <nav aria-label="Документы">
        <a href="/legal/terms">Пользовательское соглашение</a>
        <a href="/legal/privacy">Политика обработки данных</a>
        <a href="/legal/consent">Согласие на обработку данных</a>
        <a href="/legal/cookies">Cookie</a>
        <a href="/legal/music">Музыка и лицензии</a>
        <a href="/legal/contacts">Контакты</a>
      </nav>
    </footer>
  {/if}
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
  .name {
    font-size: var(--t-s);
    color: var(--on-room-2);
    max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
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
    .top nav a {
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
  /* compact: ярлыки переносятся и растягиваются по строкам, значки — колонкой справа. */
  @media (max-width: 599px) {
    .top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .top nav a {
      flex: 1 1 auto;
      justify-content: center;
    }
    .icons {
      flex-direction: column;
      gap: 6px;
    }
    .foot {
      font-size: 0.8125rem;
    }
  }
</style>
