<script lang="ts">
  let { scene = "home" }: { scene?: string } = $props();
  const backgrounds: Record<string, string> = { home: "home-no-lamp", songs: "02-song-selection", tracks: "02-song-selection", mic: "03-microphone-check", sing: "04-performance", result: "05-result", duels: "06-duel", friends: "06-duel", leaders: "07-leaderboard", progress: "04-performance", account: "09-empty-state", legal: "09-empty-state" };
  const file = $derived(backgrounds[scene] ?? backgrounds.home);
</script>
<div class="wall" class:home={scene === "home"} aria-hidden="true">
  <img src="/art/backgrounds/{backgrounds[scene] ?? backgrounds.home}.webp?v=web-1" alt="" width="2560" height="1440" />
  <!-- На фоне лидеров стопка кейсов с подписями реальных групп: поверх неё нейтральная стопка
       без надписей. Холст повторяет геометрию object-fit: cover, поэтому место совпадает на любом окне. -->
  {#if file === "07-leaderboard"}
    <div class="canvas">
      <svg class="patch" viewBox="0 0 380 250">
        {#each [0, 1, 2, 3, 4, 5, 6] as i (i)}
          <rect x={12 + (i % 2) * 6} y={214 - i * 31} width="330" height="27" rx="3" fill={i === 3 ? "#5a1d1d" : i === 1 ? "#4a4744" : "#1f1e1f"} stroke="#0b0b0c" stroke-width="3" />
          <rect x={120 + (i % 2) * 6} y={222 - i * 31} width="110" height="11" rx="1" fill="#6f675d" opacity="0.75" />
        {/each}
      </svg>
    </div>
  {/if}
</div>
<style>
  .wall { position: fixed; inset: 0; z-index: -1; pointer-events: none; background: #121213; overflow: hidden; container-type: size; }
  img { width: 100%; height: 100%; object-fit: cover; filter: saturate(.65) brightness(.46); }
  .home img { filter: saturate(.68) brightness(.55); }
  .canvas { position: absolute; left: 50%; top: 50%; width: max(100cqw, calc(100cqh * 16 / 9)); height: max(100cqh, calc(100cqw * 9 / 16)); translate: -50% -50%; filter: saturate(.65) brightness(.46); }
  .patch { position: absolute; left: 2.6%; top: 78.3%; width: 14.6%; height: auto; }
  .wall::after { content: ""; position: absolute; inset: 0; background: radial-gradient(ellipse at 53% 45%, #14131515, #10101250 85%), linear-gradient(#11111330, transparent 30%, #11111365); }
</style>
