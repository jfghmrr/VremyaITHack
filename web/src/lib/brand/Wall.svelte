<script lang="ts">
  let { scene = "home" }: { scene?: string } = $props();
  const backgrounds: Record<string, string> = { home: "home-no-lamp", songs: "02-song-selection", mic: "03-microphone-check", sing: "04-performance", result: "05-result", duels: "06-duel", friends: "06-duel", leaders: "07-leaderboard", progress: "04-performance", account: "09-empty-state", legal: "09-empty-state" };
</script>
<div class="wall" class:home={scene === "home"} aria-hidden="true">
  <img src="/art/backgrounds/{backgrounds[scene] ?? backgrounds.home}.webp?v=restored-1" alt="" width="2560" height="1440" />
</div>
<style>
  .wall { position: fixed; inset: 0; z-index: -1; pointer-events: none; background: #121213; overflow: hidden; }
  img { width: 100%; height: 100%; object-fit: cover; filter: saturate(.65) brightness(.46); }
  .home img { filter: saturate(.68) brightness(.55); }
  .wall::after { content: ""; position: absolute; inset: 0; background: radial-gradient(ellipse at 53% 45%, #14131515, #10101250 85%), linear-gradient(#11111330, transparent 30%, #11111365); }
</style>
