<script lang="ts" module>
  // Обложка CD-бокса собирается из id песни: палитра, мотив и шрифт заголовка
  // фиксированы для каждой песни. Мотив «контур» — настоящая мелодия этой песни.
  const PALETTES = [
    ["#a81d1d", "#f5f0e6", "#151415"],
    ["#151415", "#efe6d2", "#c43a3f"],
    ["#c99a2e", "#151415", "#a81d1d"],
    ["#4a6687", "#f5f0e6", "#e0b54a"],
    ["#3e5a46", "#efe6d2", "#d9a93c"],
    ["#efe6d2", "#151415", "#a81d1d"],
    ["#b9b8b2", "#151415", "#4a6687"],
    ["#c9ae84", "#151415", "#3e5a46"],
  ];
  const MOTIFS = ["contour", "sun", "stars", "stripes", "vinyl", "dots", "waves", "contour"] as const;
  const FONTS = [
    { family: "var(--font-poster)", upper: true, weight: 700, size: 1 },
    { family: "var(--font-serif)", upper: false, weight: 700, size: 0.92 },
    { family: "var(--font-block)", upper: true, weight: 400, size: 0.7 },
    { family: "var(--font-hand)", upper: false, weight: 700, size: 1.2 },
    { family: "var(--font)", upper: false, weight: 850, size: 0.9 },
  ];
  function hash(s: string) {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
    return h >>> 0;
  }
</script>

<script lang="ts">
  import { contourDrawable, smoothContour } from "./cover-contour.ts";
  let { id, title, contour: raw }: { id: string; title: string; contour?: (number | null)[] } = $props();

  // Контур со сглаженными короткими паузами; слишком рваный — не рисуется (волны вместо него).
  const contour = $derived.by(() => {
    if (!raw) return undefined;
    const s = smoothContour(raw);
    return contourDrawable(s) ? s : undefined;
  });
  const h = $derived(hash(id));
  const pal = $derived(PALETTES[h % PALETTES.length]);
  const motif = $derived(MOTIFS[(h >>> 4) % MOTIFS.length] === "contour" && !contour ? "waves" : MOTIFS[(h >>> 4) % MOTIFS.length]);
  const font = $derived(FONTS[(h >>> 8) % FONTS.length]);
  const bottom = $derived(((h >>> 12) & 1) === 1);
  const fit = $derived(title.length > 26 ? 0.62 : title.length > 16 ? 0.78 : 1);

  const line = $derived.by(() => {
    if (!contour) return "";
    const v = contour.filter((x): x is number => x !== null);
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    let d = "";
    let pen = false;
    contour.forEach((m, i) => {
      if (m === null) return void (pen = false);
      const x = 6 + (i / (contour.length - 1)) * 88;
      const y = (bottom ? 22 : 58) + 22 - ((m - lo) / Math.max(1, hi - lo)) * 22;
      d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const starAt = (x: number, y: number, r: number) =>
    Array.from({ length: 10 }, (_, i) => {
      const rr = i % 2 ? r * 0.45 : r;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      return `${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)}`;
    }).join(" ");
</script>

<span class="cover" class:bottom style:--bg={pal[0]} style:--fg={pal[1]} style:--ac={pal[2]}>
  <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    {#if motif === "contour"}
      <path d={line} fill="none" stroke={pal[2]} stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    {:else if motif === "sun"}
      {#each Array.from({ length: 14 }, (_, i) => i) as i (i)}
        <path d="M72 {bottom ? 30 : 70} L {72 + 60 * Math.cos((i / 14) * 2 * Math.PI)} {(bottom ? 30 : 70) + 60 * Math.sin((i / 14) * 2 * Math.PI)}" stroke={pal[2]} stroke-width="3" opacity="0.85" />
      {/each}
      <circle cx="72" cy={bottom ? 30 : 70} r="14" fill={pal[2]} />
    {:else if motif === "stars"}
      {#each [[22, 30, 9], [70, 18, 6], [82, 44, 11], [40, 60, 5], [16, 82, 7], [62, 76, 8]] as [x, y, r] (x)}
        <polygon points={starAt(x, bottom ? y * 0.6 : y * 0.5 + 45, r)} fill={pal[2]} />
      {/each}
    {:else if motif === "stripes"}
      {#each [0, 1, 2, 3] as i (i)}
        <path d="M{-20 + i * 26} 110 L {40 + i * 26} -10" stroke={i % 2 ? pal[1] : pal[2]} stroke-width="9" opacity="0.8" />
      {/each}
    {:else if motif === "vinyl"}
      {#each [44, 36, 28, 20] as r (r)}
        <circle cx="78" cy={bottom ? 22 : 78} {r} fill="none" stroke={pal[2]} stroke-width={r === 20 ? 14 : 1.2} />
      {/each}
    {:else if motif === "dots"}
      {#each Array.from({ length: 49 }, (_, i) => i) as i (i)}
        <circle cx={8 + (i % 7) * 14} cy={(bottom ? 6 : 52) + Math.floor(i / 7) * 6.5} r={0.6 + ((i % 7) / 7) * 2.6} fill={pal[2]} />
      {/each}
    {:else}
      {#each [0, 1, 2, 3, 4] as i (i)}
        <path d="M0 {(bottom ? 14 : 56) + i * 7} q 12.5 -7 25 0 t 25 0 t 25 0 t 25 0" fill="none" stroke={pal[2]} stroke-width="1.8" opacity={1 - i * 0.15} vector-effect="non-scaling-stroke" />
      {/each}
    {/if}
  </svg>
  <!-- Название на обложке — рисунок (CSS content): в тексте страницы оно одно, в подписи полароида. -->
  <span
    class="title"
    aria-hidden="true"
    data-title={title}
    style:font-family={font.family}
    style:font-weight={font.weight}
    style:text-transform={font.upper ? "uppercase" : "none"}
    style:--fs={font.size * fit}
  ></span>
</span>

<style>
  .cover {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    aspect-ratio: 1;
    overflow: hidden;
    padding: 9% 9% 9% 12%;
    background: var(--bg) var(--tex-paper);
    color: var(--fg);
  }
  .cover.bottom {
    justify-content: flex-end;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .title {
    position: relative;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: calc(var(--cover-fs, 1.25rem) * var(--fs));
    line-height: 1.02;
    letter-spacing: -0.005em;
    overflow-wrap: anywhere;
    hyphens: auto;
  }
  .title::before {
    content: attr(data-title);
  }
</style>
