<script lang="ts">
  // Оформление правовых документов: читаемая колонка текста и навигация между ними.
  import { legalNavigation } from "./navigation.svelte.ts";
  import { page } from "$app/state";
  let { title, updated, children }: { title: string; updated: string; children: import("svelte").Snippet } = $props();
  const docs = [
    { href: "/legal/terms", label: "Пользовательское соглашение" },
    { href: "/legal/privacy", label: "Политика обработки данных" },
    { href: "/legal/consent", label: "Согласие на обработку данных" },
    { href: "/legal/cookies", label: "Cookie и хранилище браузера" },
    { href: "/legal/music", label: "Музыка и лицензии" },
    { href: "/legal/contacts", label: "Контакты" },
  ];
</script>

<div class="legal">
  <nav aria-label="Документы">
    {#each docs as d (d.href)}
      <a href={d.href} aria-current={page.url.pathname === d.href ? "page" : undefined}>{d.label}</a>
    {/each}
  </nav>
  <article>
    <a class="close-legal" href={legalNavigation.returnTo} aria-label="Закрыть документы" title="Закрыть документы">×</a>
    <h1>{title}</h1>
    <p class="updated">Редакция от {updated}</p>
    {@render children()}
  </article>
</div>

<style>
  .legal {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    gap: var(--s-7);
    padding-top: var(--s-5);
    padding-bottom: var(--s-7);
  }
  /* Документы — закладки в папке: текущая выдвинута и вишнёвая. */
  nav {
    display: grid;
    align-content: start;
    gap: var(--s-2);
    position: sticky;
    top: var(--s-5);
  }
  nav a {
    padding: var(--s-2) var(--s-3);
    background: var(--paper-3) var(--tex-paper);
    color: var(--ink);
    text-decoration: none;
    font-size: var(--t-s);
    clip-path: polygon(0 0, 96% 0, 100% 50%, 96% 100%, 0 100%);
    transition: transform var(--d-fast) var(--ease);
  }
  nav a:hover {
    background-color: var(--paper);
    transform: translateX(4px);
  }
  nav a[aria-current="page"] {
    background-color: var(--accent);
    color: var(--paper-2);
    font-weight: 600;
    transform: translateX(10px);
  }
  nav a:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 3px var(--focus);
  }
  /* Текст документа — ровный лист бумаги без наклона. */
  .close-legal { position: sticky; float: right; top: 16px; display: grid; place-items: center; width: 36px; height: 36px; margin: -12px -16px 4px 12px; background: var(--paper); border: 1px solid #b0a58e; border-radius: 50%; text-decoration: none; font: 26px/1 var(--font-sans); z-index: 2; }
  .close-legal:hover { color: var(--paper-2); background: var(--accent); }
  article {
    --muted: var(--ink-2);
    max-width: 78ch;
    padding: var(--s-6) var(--s-7) var(--s-7);
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
    border-radius: 2px;
    box-shadow: var(--shadow-sheet);
  }
  h1 {
    font-size: var(--t-3xl);
    letter-spacing: -0.02em;
  }
  .updated {
    margin: var(--s-2) 0 var(--s-6);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--t-xs);
  }
  article :global(h2) {
    font-size: var(--t-xl);
    margin: var(--s-6) 0 var(--s-3);
  }
  article :global(p),
  article :global(li) {
    line-height: 1.6;
    margin-bottom: var(--s-2);
  }
  article :global(a) {
    color: var(--accent);
  }
  article :global(ul) {
    padding-left: 1.25em;
  }
  article :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: var(--s-3) 0 var(--s-5);
    font-size: var(--t-s);
  }
  article :global(th),
  article :global(td) {
    text-align: left;
    vertical-align: top;
    padding: var(--s-2) var(--s-3) var(--s-2) 0;
    border-bottom: 1px solid var(--line);
  }
  article :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  article :global(.todo) {
    color: var(--accent);
    font-weight: 600;
  }
  /* Сенсорный экран или не wide: закладки и крестик не меньше 44 px. */
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    nav a {
      display: flex;
      align-items: center;
      min-height: var(--tap);
    }
    .close-legal {
      width: var(--tap);
      height: var(--tap);
    }
  }
  /* Не wide: закладки документов рядом над листом, лист во всю ширину. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .legal {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-5);
    }
    nav {
      position: static;
      display: flex;
      flex-wrap: wrap;
    }
    nav a {
      display: inline-flex;
      padding-right: var(--s-5);
    }
    nav a[aria-current="page"] {
      transform: none;
    }
    article {
      padding: var(--s-5) var(--s-5) var(--s-6);
    }
  }
  /* compact: таблицы документа прокручиваются внутри листа, а не всей страницей. */
  @media (max-width: 599px) {
    article {
      padding: var(--s-5) var(--s-4) var(--s-6);
    }
    h1 {
      font-size: var(--t-2xl);
    }
    article :global(table) {
      display: block;
      overflow-x: auto;
    }
  }
</style>
