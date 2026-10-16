<script lang="ts" module>
  export type Mood = "idle" | "groove" | "listening" | "singing" | "happy" | "thumbs" | "shy" | "tear" | "sleepy" | "unplugged" | "empty" | "lying";
  export type CatSignal = () => { level: number; pitch: number | null };
</script>
<script lang="ts">
  import { reducedMotion } from "#lib/ui/canvas.ts";
  let { mood = "idle", size = 220, signal, say = "", tint = "red" }: { mood?: Mood; size?: number | string; signal?: CatSignal; say?: string; tint?: "red" | "blue" } = $props();
  const poses: Record<Mood, string> = { idle: "cat-listen-s01", groove: "cat-guitar-s03", listening: "cat-sing-s01", singing: "cat-sing-s02", happy: "cat-paw-up-s01", thumbs: "cat-paw-up-s01", shy: "cat-encouragement-s03", tear: "cat-encouragement-s03", sleepy: "cat-sleep-s02", unplugged: "cat-empty-s03", empty: "cat-laptop-s03", lying: "cat-sleep-s01" };
  let figure: HTMLElement;
  $effect(() => {
    const read = signal;
    const activeMood = mood;
    if (!figure || !read || reducedMotion()) return;
    let raf = 0, vol = 0, last = 0;
    const step = (now: number) => {
      if (now - last >= 32 && !document.hidden) {
        const s = read();
        vol += (Math.min(1, Math.max(0, s.level)) - vol) * .3;
        const angle = s.pitch === null ? 0 : (s.pitch - .5) * 4;
        // Композитный transform готовой вырезки: без SVG-фильтров и layout.
        figure.style.setProperty("--lift", `${-vol * 5}px`);
        figure.style.setProperty("--tilt", `${activeMood === "singing" ? angle : -vol * 3}deg`);
        last = now;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });
</script>
<figure bind:this={figure} class="cat" class:groove={mood === "groove"} class:rival={tint === "blue"} style:--w={typeof size === "number" ? `${size}px` : size} aria-hidden="true">
  <img src="/art/mascots/{poses[mood]}.webp?v=restored-1" alt="" draggable="false" />
  {#if say}<figcaption>{say}</figcaption>{/if}
</figure>
<style>
  .cat { position: relative; display: block; width: var(--w); max-width: 100%; margin: 0; transform: translateY(var(--lift, 0px)) rotate(var(--tilt, 0deg)); transform-origin: 50% 85%; }
  img { display: block; width: 100%; height: auto; max-height: 100%; object-fit: contain; filter: drop-shadow(0 8px 6px #0006); user-select: none; }
  figcaption { position: absolute; left: 70%; top: 7%; padding: 3px 13px 6px; min-width: max-content; max-width: 180px; background: var(--paper); color: var(--ink); font: 700 clamp(16px, 1.9vw, 28px)/1.1 var(--font-hand); transform: rotate(7deg); clip-path: polygon(0 5%, 95% 0, 100% 92%, 5% 100%); }
  .groove { animation: sway 2s ease-in-out infinite alternate; }
  @keyframes sway { to { transform: rotate(2deg) translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .cat { animation: none; transform: none; } }
</style>
