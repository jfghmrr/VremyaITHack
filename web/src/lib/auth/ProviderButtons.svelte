<script lang="ts">
  // Вход через Яндекс ID и VK ID (разрешённые способы по ч. 10 ст. 8 149-ФЗ).
  // Кнопка видна, только если сервер настроен для провайдера; переход — обычная ссылка:
  // сервер сам перенаправляет к провайдеру и обратно.
  import { onMount } from "svelte";
  import { api } from "#lib/api/http.ts";

  let { returnTo = "/account" }: { returnTo?: string } = $props();
  const labels: Record<string, string> = { yandex: "Яндекс ID", vk: "VK ID" };
  let providers = $state<string[]>([]);

  onMount(() => {
    api<{ providers?: unknown }>("auth/providers")
      .then((r) => {
        providers = Array.isArray(r.providers) ? r.providers.filter((p): p is string => typeof p === "string" && p in labels) : [];
      })
      .catch(() => (providers = []));
  });
</script>

{#if providers.length}
  <div class="providers" role="group" aria-label="Вход через сервисы">
    {#each providers as provider (provider)}
      <a class="provider {provider}" href="/api/auth/{provider}/start?return={encodeURIComponent(returnTo)}" data-sveltekit-reload>
        <span class="mark" aria-hidden="true">{provider === "yandex" ? "Я" : "VK"}</span>
        <span>Войти через {labels[provider]}</span>
      </a>
    {/each}
    <p class="or"><span>или по почте</span></p>
  </div>
{/if}

<style>
  .providers {
    display: grid;
    gap: var(--s-2);
  }
  .provider {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-3);
    min-height: 48px;
    padding: 0 var(--s-4);
    border-radius: 6px;
    font-weight: 650;
    font-size: var(--t-m);
    text-decoration: none;
    transition: transform var(--d-fast) var(--ease), filter var(--d-fast) var(--ease);
  }
  .provider:hover {
    transform: translateY(-1px);
    filter: brightness(1.08);
  }
  .yandex {
    background: #1f1c1a;
    color: #fff;
  }
  .vk {
    background: #0077ff;
    color: #fff;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    font-size: 0.8rem;
    font-weight: 800;
    line-height: 1;
  }
  .yandex .mark {
    background: #fc3f1d;
    color: #fff;
    font-size: 1rem;
  }
  .vk .mark {
    background: #fff;
    color: #0077ff;
  }
  .or {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    margin: var(--s-1) 0 0;
    color: var(--ink-2);
    font-size: var(--t-xs);
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--line-strong);
  }
</style>
