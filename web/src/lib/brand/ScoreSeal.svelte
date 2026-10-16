<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children: Snippet } = $props();
</script>
<div class="seal"><svg viewBox="0 0 240 220" aria-hidden="true"><path d="M116 5 143 64 210 55 180 115 236 153 164 165 159 217 112 181 57 215 61 157 5 129 62 97 48 32 101 55Z" fill="#a72a28" stroke="#ede0c4" stroke-width="7" stroke-linejoin="round"/><path d="m83 49 16 19M188 75l-16 30M26 129l34-4M157 194l-10-25" fill="none" stroke="#e6c7a3" stroke-width="2" opacity=".6"/></svg><div class="value">{@render children()}</div></div>
<style>.seal{position:relative;width:min(100%,220px);height:190px;flex-shrink:0;display:grid;place-items:center}svg{position:absolute;width:100%;height:100%;filter:drop-shadow(0 3px 2px #0003)}.value{position:relative;padding-top:8px}@media (min-width:1100px) and (min-height:521px) and (max-height:800px){.seal{height:150px;width:175px}}</style>
