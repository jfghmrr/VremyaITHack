<script lang="ts">
  import type { Snippet } from "svelte";
  import { artDims, PHONE_BLANK } from "./art";
  import { PHONE_QUERY } from "#lib/ui/stage.svelte.ts";
  // skipOnPhone — как у Asset: на телефоне в портрете звезда скрыта вместе с комнатой и не скачивается.
  let { variant = "patch", size = 64, loading = "lazy", skipOnPhone = false, children }: { variant?: "patch" | "spiral" | "print" | "outline"; size?: number | string; loading?: "lazy" | "eager"; skipOnPhone?: boolean; children?: Snippet } = $props();
  const pictures = { patch: "star-red-distressed-s02", spiral: "star-spiral-s01", print: "star-black-s03", outline: "star-cream-outline-s01" };
</script>
<span class="star {variant}" style:--size={typeof size === "number" ? `${size}px` : size}>
  {#if skipOnPhone}
    <picture class="phone-skip"><source media={PHONE_QUERY} srcset={PHONE_BLANK} /><img src="/art/stickers/{pictures[variant]}.webp?v=web-1" alt="" {...artDims(`stickers/${pictures[variant]}`)} {loading} draggable="false" /></picture>
  {:else}
    <img src="/art/stickers/{pictures[variant]}.webp?v=web-1" alt="" {...artDims(`stickers/${pictures[variant]}`)} {loading} draggable="false" />
  {/if}
  {#if children}<span class="content">{@render children()}</span>{/if}
</span>
<style>
  .star { position: relative; display: inline-grid; place-items: center; width: var(--size); aspect-ratio: 1; flex: none; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; }
  .content { position: relative; display: grid; place-items: center; padding-top: 6%; color: var(--paper-2); text-align: center; }
  .spiral .content { color: var(--accent); }
  .phone-skip { display: contents; }
</style>
