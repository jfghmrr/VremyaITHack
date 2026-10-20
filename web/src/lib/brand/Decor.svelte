<script lang="ts">
  import { artDims } from "./art";
  // Предметы комнаты для главной: настольная лампа, магнитофон, кружка, стопка дисков.
  // Вырезки предоставленного набора; для остальных предметов сохранён векторный вариант.
  // Стопка кейсов рисуется кодом: прежняя вырезка с подписями реальных групп удалена из набора.
  // Пластинки тоже рисуются кодом: на вырезке music/vinyl-photo-stack-s03 был чужой товарный знак (удалена).
  let { kind, width = 160, text = "" }: { kind: "lamp" | "boombox" | "mug" | "cds" | "micstand" | "headphones" | "vinyls" | "shelf" | "poster" | "notes" | "cases"; width?: number | string; text?: string } = $props();
  const words = $derived(text.split(" "));
  const photos: Partial<Record<typeof kind, string>> = { boombox: "devices/boombox-s02", headphones: "music/headphones-s01", cds: "music/compact-disc-s01", notes: "doodles/note-pair-s01" };
</script>

{#if photos[kind]}
  <img class="asset" src="/art/{photos[kind]}.webp?v=web-1" alt="" {...artDims(photos[kind] ?? "")} loading="lazy" style:width={typeof width === "number" ? `${width}px` : width} />
{:else if kind === "lamp"}
  <svg class="decor" viewBox="0 0 200 220" {width} aria-hidden="true">
    <defs>
      <radialGradient id="lamp-glow" cx="0.5" cy="0" r="1">
        <stop offset="0" stop-color="#ffd59a" stop-opacity="0.55" />
        <stop offset="1" stop-color="#ffd59a" stop-opacity="0" />
      </radialGradient>
    </defs>
    <path d="M118 92 L 40 220 H 200 L 160 92 Z" fill="url(#lamp-glow)" />
    <path d="M60 214 h70" stroke="#121112" stroke-width="10" stroke-linecap="round" />
    <path d="M95 210 L 70 130 L 112 64" stroke="#2a292a" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="70" cy="130" r="6" fill="#3a393a" />
    <path d="M96 42 L 152 78 L 140 98 Q 112 104 90 82 Z" fill="#1d1c1d" stroke="#3a393a" stroke-width="2" />
    <ellipse cx="128" cy="94" rx="16" ry="6" fill="#ffe2a8" transform="rotate(30 128 94)" />
  </svg>
{:else if kind === "boombox"}
  <svg class="decor" viewBox="0 0 220 130" {width} aria-hidden="true">
    <path d="M60 20 Q 110 -6 160 20" stroke="#8e8d88" stroke-width="6" fill="none" />
    <rect x="4" y="18" width="212" height="108" rx="10" fill="#2b2a2c" stroke="#121112" stroke-width="3" />
    <rect x="12" y="26" width="196" height="12" rx="3" fill="#3c3a3d" />
    {#each [54, 166] as cx (cx)}
      <circle {cx} cy="80" r="36" fill="#141314" stroke="#5c5a5d" stroke-width="3" />
      <circle {cx} cy="80" r="24" fill="#1f1e20" stroke="#3a393b" stroke-width="2" />
      <circle {cx} cy="80" r="7" fill="#5c5a5d" />
    {/each}
    <rect x="94" y="56" width="32" height="20" rx="2" fill="#b9b8b2" />
    <rect x="94" y="84" width="32" height="26" rx="2" fill="#141314" stroke="#5c5a5d" />
    <circle cx="200" cy="32" r="3" fill="#d8453c" />
  </svg>
{:else if kind === "mug"}
  <svg class="decor" viewBox="0 0 140 130" {width} aria-hidden="true">
    <path d="M100 44 q 34 4 30 34 q -4 26 -32 24" stroke="#e9e1cf" stroke-width="10" fill="none" />
    <path d="M14 26 h92 l -6 92 q -1 8 -10 8 h -60 q -9 0 -10 -8 z" fill="#e9e1cf" stroke="#bdb39f" stroke-width="2" />
    <ellipse cx="60" cy="26" rx="46" ry="7" fill="#3a2a22" stroke="#bdb39f" stroke-width="2" />
    <text x="58" y="66" text-anchor="middle" class="mug">клуб</text>
    <text x="58" y="84" text-anchor="middle" class="mug">хороших</text>
    <text x="58" y="102" text-anchor="middle" class="mug">голосов</text>
  </svg>
{:else if kind === "micstand"}
  <svg class="decor" viewBox="0 0 80 220" {width} aria-hidden="true">
    <path d="M40 60 V 206 M14 214 L 40 200 L 66 214" stroke="#2a292a" stroke-width="6" fill="none" stroke-linecap="round" />
    <rect x="33" y="34" width="14" height="34" rx="5" fill="#1d1c1d" stroke="#6c6a66" />
    <circle cx="40" cy="26" r="16" fill="#bdbcb6" stroke="#4f4e4b" stroke-width="2.5" />
    <path d="M27 20h26M25 26h30M27 32h26M34 12v28M40 10v32M46 12v28" stroke="#6f6e69" stroke-width="1.2" />
  </svg>
{:else if kind === "headphones"}
  <svg class="decor" viewBox="0 0 160 150" {width} aria-hidden="true">
    <path d="M24 100 C 18 20, 142 20, 136 100" stroke="#1d1c1d" stroke-width="12" fill="none" stroke-linecap="round" />
    <path d="M30 96 C 26 34, 134 34, 130 96" stroke="#4a4846" stroke-width="3" fill="none" />
    <rect x="6" y="86" width="38" height="58" rx="16" fill="#1d1c1d" stroke="#5c5a5d" stroke-width="3" />
    <rect x="116" y="86" width="38" height="58" rx="16" fill="#1d1c1d" stroke="#5c5a5d" stroke-width="3" />
  </svg>
{:else if kind === "vinyls"}
  <svg class="decor" viewBox="0 0 200 120" {width} aria-hidden="true">
    {#each [0, 1, 2, 3] as i (i)}
      <rect x={4 + i * 4} y={96 - i * 22} width="180" height="20" rx="2" fill={["#2b2a2c", "#7a1c1c", "#1d1c1d", "#3a3836"][i]} stroke="#0c0b0c" stroke-width="2" transform="rotate({(i - 1.5) * 1.5} 94 {106 - i * 22})" />
    {/each}
    <circle cx="150" cy="30" r="28" fill="#0e0d0e" stroke="#2a2829" stroke-width="2" />
    <circle cx="150" cy="30" r="9" fill="#a81d1d" />
  </svg>
{:else if kind === "shelf"}
  <svg class="decor" viewBox="0 0 200 110" {width} aria-hidden="true">
    <rect x="0" y="100" width="200" height="10" fill="#3a2a22" />
    {#each Array.from({ length: 14 }, (_, i) => i) as i (i)}
      <rect x={6 + i * 13.5} y={20 + ((i * 37) % 26)} width="12" height={80 - ((i * 37) % 26)} fill={["#a81d1d", "#2b2a2c", "#c99a2e", "#34506e", "#efe6d2", "#3e5a46", "#1d1c1d"][i % 7]} stroke="#0c0b0c" stroke-width="1.2" />
    {/each}
  </svg>
{:else if kind === "poster"}
  <svg class="decor" viewBox="0 0 120 170" {width} aria-hidden="true">
    <rect width="120" height="170" fill="#d9cdb4" />
    {#each words as w, i (i)}
      <rect x={8 + (i % 2) * 6} y={10 + i * 30} width={Math.min(104, 14 + w.length * 13)} height="26" fill={i % 3 === 1 ? "#a81d1d" : i % 3 === 2 ? "#1d1c1d" : "#efe6d2"} transform="rotate({(i % 2 ? 2 : -2)} 60 {22 + i * 30})" />
      <text x={14 + (i % 2) * 6} y={30 + i * 30} class="post" fill={i % 3 === 0 ? "#1d1c1d" : "#efe6d2"} transform="rotate({(i % 2 ? 2 : -2)} 60 {22 + i * 30})">{w}</text>
    {/each}
  </svg>
{:else if kind === "notes"}
  <svg class="decor" viewBox="0 0 60 60" {width} aria-hidden="true">
    <path d="M14 46 V 14 L 40 8 V 40" stroke="#efe6d2" stroke-width="3" fill="none" />
    <ellipse cx="10" cy="46" rx="7" ry="5" fill="#efe6d2" />
    <ellipse cx="36" cy="40" rx="7" ry="5" fill="#efe6d2" />
  </svg>
{:else if kind === "cases"}
  <svg class="decor" viewBox="0 0 190 170" {width} aria-hidden="true">
    {#each Array.from({ length: 8 }, (_, i) => i) as i (i)}
      <rect x={8 + (i % 3) * 3} y={150 - i * 19} width="172" height="17" rx="2" fill={["#2e3e52", "#7a1c1c", "#1d1c1d", "#5f5e5a", "#3a1a1a", "#1d1c1d", "#34506e", "#4a4846"][i]} stroke="#0c0b0c" stroke-width="1.5" />
      <!-- Пустая бумажная подпись: без названий групп. -->
      <rect x={60 + (i % 3) * 3} y={154 - i * 19} width="70" height="9" fill="#d9cbb0" opacity="0.62" />
    {/each}
  </svg>
{:else}
  <svg class="decor" viewBox="0 0 170 90" {width} aria-hidden="true">
    {#each ["#a81d1d", "#1d1c1d", "#b9b8b2", "#34506e", "#1d1c1d"] as c, i (i)}
      <rect x={6 + (i % 2) * 6} y={70 - i * 16} width="150" height="15" rx="2" fill={c} stroke="#0c0b0c" stroke-width="1.5" transform="rotate({(i - 2) * 1.2} 80 {78 - i * 16})" />
    {/each}
  </svg>
{/if}

<style>
  .asset { display: block; max-width: 100%; height: auto; object-fit: contain; filter: drop-shadow(0 5px 4px #0006); }
  .decor {
    display: block;
    height: auto;
    overflow: visible;
    filter: drop-shadow(0 10px 14px rgb(0 0 0 / 0.6));
  }
  .post {
    font-family: var(--font-poster);
    font-weight: 700;
    font-size: 15px;
  }
  .mug {
    font-family: var(--font-poster);
    font-weight: 700;
    font-size: 15px;
    fill: #a81d1d;
  }
</style>
