<script lang="ts">
  import { artDims } from "./art";
  let { label, note = "", side = "A", tone = "black", spinning = false, width = 260 }: { label: string; note?: string; side?: string; tone?: "black" | "red"; spinning?: boolean; width?: number } = $props();
  // Чистые наклейки: на исходных вырезках набора были написаны реальные группы и песни (удалены 17.10.2026).
  const photos = { black: "black-blank", red: "red-blank" };
</script>
<div class="cassette" class:spinning style:width="{width}px" aria-hidden="true">
  <img src="/art/cassettes/cassette-{photos[tone]}.webp?v=web-1" alt="" {...artDims(`cassettes/cassette-${photos[tone]}`)} loading="lazy" />
  <span class="label">{label}</span><span class="side">{side}</span>
  <i class="reel one"></i><i class="reel two"></i>
  {#if note}<span class="note-label">{note}</span>{/if}
</div>
<style>
  .cassette { position: relative; flex: none; max-width: 100%; aspect-ratio: 1.55; filter: drop-shadow(0 8px 7px #0007); }
  img { width: 100%; height: 100%; object-fit: fill; }
  .label { position: absolute; top: 16%; left: 12%; width: 78%; height: 22%; display: grid; place-items: center; background: var(--paper) var(--tex-paper); color: var(--ink); rotate: -3deg; font: 700 16px/1 var(--font-hand); overflow: hidden; text-align: center; }
  .side { position: absolute; top: 42%; left: 14%; font: 9px var(--font-mono); color: var(--paper); background: #161514; }
  .reel { position: absolute; top: 44%; width: 9%; aspect-ratio: 1; border-radius: 50%; border: 2px solid #ccc5b7; background: repeating-conic-gradient(#191817 0 42deg,#b5ae9f 42deg 60deg); }
  .one { left: 28%; } .two { left: 65%; }
  .note-label { position: absolute; bottom: 15%; left: 35%; padding: 1px 4px; font: 8px var(--font-mono); background: #191817; color: var(--paper); }
  .spinning .reel { animation: reel 1.8s linear infinite; }
  @keyframes reel { to { transform: rotate(-360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinning .reel { animation: none; } }
</style>
