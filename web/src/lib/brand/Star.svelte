<script lang="ts">
  import type { Snippet } from "svelte";
  let { variant = "patch", size = 64, children }: { variant?: "patch" | "spiral" | "print" | "outline"; size?: number | string; children?: Snippet } = $props();
  const pictures = { patch: "star-red-distressed-s02", spiral: "star-spiral-s01", print: "star-black-s03", outline: "star-cream-outline-s01" };
</script>
<span class="star {variant}" style:--size={typeof size === "number" ? `${size}px` : size}>
  <img src="/art/stickers/{pictures[variant]}.webp?v=restored-1" alt="" draggable="false" />
  {#if children}<span class="content">{@render children()}</span>{/if}
</span>
<style>
  .star { position: relative; display: inline-grid; place-items: center; width: var(--size); aspect-ratio: 1; flex: none; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; }
  .content { position: relative; display: grid; place-items: center; padding-top: 6%; color: var(--paper-2); text-align: center; }
  .spiral .content { color: var(--accent); }
</style>
