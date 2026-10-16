<script lang="ts">
  let { kind = "note", size = 44 }: { kind?: "note" | "heart" | "bolt"; size?: number | string } = $props();
</script>
<span class="pin" style:width={typeof size === "number" ? `${size}px` : size} aria-hidden="true">
  <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill={kind === "heart" ? "#a72b2b" : "#ddd3b8"} stroke="#aaa18b" stroke-width="3"/><circle cx="32" cy="32" r="24" fill="none" stroke="#fff6"/>
    {#if kind === "note"}<path d="M27 43V20l19-4v22M27 25l19-4" fill="none" stroke="#282422" stroke-width="4"/><ellipse cx="22" cy="43" rx="7" ry="5" fill="#282422"/><ellipse cx="41" cy="38" rx="7" ry="5" fill="#282422"/>
    {:else if kind === "heart"}<path d="M32 47C9 33 16 14 28 23l4 4 4-4c12-9 19 10-4 24Z" fill="#f0e4ca"/>
    {:else}<path d="m35 12-17 23h12l-3 17 19-25H34Z" fill="#9d2927"/>{/if}
    <path d="M17 17q11-10 27-1" stroke="#fff8" stroke-width="3" fill="none" stroke-linecap="round"/>
  </svg>
</span>
<style>.pin{display:inline-block;aspect-ratio:1;filter:drop-shadow(2px 4px 2px #0007);transform:rotate(-9deg)}svg{width:100%;height:100%;display:block}</style>
