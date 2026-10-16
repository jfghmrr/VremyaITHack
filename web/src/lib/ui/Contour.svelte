<script lang="ts">
  // Мелодический контур эталона в SVG: точный рисунок мелодии без декоративных данных.
  // `offsets` рисует ту же мелодию на разной высоте (например, бас и сопрано).
  let {
    f0,
    offsets = [0],
    colors = ["var(--accent)"],
    labels = [],
    height = 120,
    stroke = 2.5,
    animate = false,
  }: {
    f0: (number | null)[];
    offsets?: number[];
    colors?: string[];
    labels?: string[];
    height?: number;
    stroke?: number;
    animate?: boolean;
  } = $props();

  const width = 1000;
  const voiced = $derived(f0.filter((v): v is number => v !== null));
  const lo = $derived(Math.min(...voiced) + Math.min(...offsets));
  const hi = $derived(Math.max(...voiced) + Math.max(...offsets));
  const pad = 6;
  const y = (m: number) => pad + (1 - (m - lo) / Math.max(1, hi - lo)) * (height - 2 * pad);

  function path(offset: number) {
    let d = "";
    let pen = false;
    const step = Math.max(1, Math.floor(f0.length / 500));
    for (let i = 0; i < f0.length; i += step) {
      const m = f0[i];
      if (m === null) {
        pen = false;
        continue;
      }
      const x = (i / (f0.length - 1)) * width;
      d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y(m + offset).toFixed(1)}`;
      pen = true;
    }
    return d;
  }
</script>

<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" style:height="{height}px" class:animate role="img" aria-label={labels.join(", ") || "Контур мелодии"}>
  {#each offsets as offset, i (i)}
    <path
      d={path(offset)}
      fill="none"
      stroke={colors[i % colors.length]}
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
      pathLength="1"
      style:animation-delay="{i * 180}ms"
    />
  {/each}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    overflow: visible;
  }
  .animate path {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: draw 1.6s var(--ease) forwards;
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .animate path {
      animation: none;
      stroke-dashoffset: 0;
    }
  }
</style>
