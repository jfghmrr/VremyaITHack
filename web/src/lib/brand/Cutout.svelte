<script lang="ts" module>
  // Буквы-вырезки из разных печатных источников: бумага, шрифт, поворот и форма
  // ножниц выбираются по букве и её месту, поэтому одно слово всегда выглядит одинаково.
  const STYLES = [
    { bg: "var(--accent)", fg: "var(--paper-2)", font: "var(--font-block)", scale: 0.78 },
    { bg: "#e9e1cf", fg: "#141312", font: "var(--font-serif)", scale: 1 },
    { bg: "#121112", fg: "var(--paper)", font: "var(--font-poster)", scale: 1.04, weight: 700 },
    { bg: "var(--mustard)", fg: "#141312", font: "var(--font)", scale: 0.92, weight: 900 },
    { bg: "var(--paper-2)", fg: "var(--accent)", font: "var(--font-poster)", scale: 1.04, weight: 600 },
    { bg: "var(--silver)", fg: "#141312", font: "var(--font-mono)", scale: 0.95 },
    { bg: "var(--kraft)", fg: "#141312", font: "var(--font-serif)", scale: 1 },
    { bg: "var(--rival)", fg: "var(--paper-2)", font: "var(--font-poster)", scale: 1.04, weight: 500 },
  ];
  const CUTS = [
    "polygon(3% 0, 100% 4%, 96% 100%, 0 95%)",
    "polygon(0 3%, 97% 0, 100% 92%, 4% 100%)",
    "polygon(5% 4%, 95% 0, 100% 100%, 0 97%)",
    "polygon(0 0, 100% 6%, 97% 96%, 2% 100%)",
  ];
</script>

<script lang="ts">
  let { text, size = 40, seed = 0, tag = "span" }: { text: string; size?: number | string; seed?: number; tag?: "span" | "h1" | "h2" } = $props();

  const letters = $derived(
    [...text].map((ch, i) => {
      const h = (ch.codePointAt(0) ?? 0) * 31 + i * 17 + seed * 7;
      const s = STYLES[h % STYLES.length];
      return {
        ch,
        space: ch === " ",
        ...s,
        cut: CUTS[(h >> 3) % CUTS.length],
        rot: ((h % 11) - 5) * 1.1,
        dy: ((h >> 2) % 5) - 2,
        pad: 0.1 + ((h >> 4) % 3) * 0.04,
      };
    }),
  );
</script>

<svelte:element this={tag} class="cutout" style:--size={typeof size === "number" ? `${size}px` : size}>
  <span class="visually-hidden">{text}</span>
  <span class="letters" aria-hidden="true">
    {#each letters as l, i (i)}
      {#if l.space}
        <span class="gap"></span>
      {:else}
        <span
          class="l"
          style:--bg={l.bg}
          style:--fg={l.fg}
          style:--lf={l.font}
          style:--weight={l.weight ?? 400}
          style:--scale={l.scale}
          style:--cut={l.cut}
          style:--rot="{l.rot}deg"
          style:--dy="{l.dy}px"
          style:--pad="{l.pad}em">{l.ch}</span
        >
      {/if}
    {/each}
  </span>
</svelte:element>

<style>
  .cutout {
    display: inline-block;
    margin: 0;
    font-size: var(--size);
    line-height: 1;
  }
  .letters {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.05em 0.04em;
    filter: drop-shadow(0 1.5px 0 rgb(0 0 0 / 0.55));
  }
  .l {
    display: inline-grid;
    place-items: center;
    min-width: calc(0.8em / var(--scale));
    height: calc(1.12em / var(--scale));
    padding: 0 var(--pad);
    background: var(--bg) var(--tex-paper);
    color: var(--fg);
    font-family: var(--lf);
    font-weight: var(--weight);
    font-size: calc(1em * var(--scale));
    line-height: 1;
    text-transform: uppercase;
    clip-path: var(--cut);
    transform: translateY(var(--dy)) rotate(var(--rot));
  }
  .gap {
    width: 0.32em;
  }
</style>
