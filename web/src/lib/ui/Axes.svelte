<script lang="ts">
  import type { Axes } from "#lib/scoring/types.ts";
  let { axes, compact = false }: { axes: Axes; compact?: boolean } = $props();
  const names: [keyof Axes, string, string][] = [
    ["intervals", "Интервалы", "Точность шагов мелодии в твоей тональности"],
    ["rhythm", "Ритм", "Начала нот после вычета общей задержки"],
    ["stability", "Устойчивость", "Ровность длинных нот и тональности между фразами"],
    ["coverage", "Покрытие", "Какая часть мелодии спета"],
  ];
</script>

<dl class="axes" class:compact>
  {#each names as [key, label, hint] (key)}
    <div class="axis">
      <dt title={hint}>{label}</dt>
      <dd>
        <b>{Math.round(axes[key] * 100)}</b>
        <span class="track" aria-hidden="true"><i style:width="{axes[key] * 100}%"></i></span>
      </dd>
    </div>
  {/each}
</dl>

<style>
  /* Показатели — бумажные билеты со шкалой-линейкой: деления каждые 10 баллов. */
  .axes {
    display: grid;
    gap: 6px;
    margin: 0;
  }
  .axis {
    display: grid;
    grid-template-columns: 8.5rem 1fr;
    align-items: center;
    gap: var(--s-3);
    padding: 5px var(--s-4) 5px var(--s-4);
    background: var(--paper) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-sticker);
    border-left: 2px dashed var(--line-strong);
  }
  .axis:nth-child(odd) {
    transform: rotate(-0.4deg);
  }
  .axis:nth-child(even) {
    transform: rotate(0.3deg);
  }
  dt {
    color: var(--ink-2);
    font-size: var(--t-s);
  }
  dd {
    display: grid;
    grid-template-columns: 2.25rem 1fr;
    align-items: center;
    gap: var(--s-3);
    margin: 0;
  }
  b {
    font-family: var(--font-mono);
    font-weight: 500;
    text-align: right;
  }
  .track {
    position: relative;
    height: 12px;
    background:
      repeating-linear-gradient(90deg, var(--ink-3) 0 1px, transparent 1px 10%) bottom / 100% 5px no-repeat,
      linear-gradient(var(--ink-3), var(--ink-3)) bottom / 100% 1px no-repeat;
  }
  .track i {
    position: absolute;
    left: 0;
    top: 1px;
    display: block;
    height: 5px;
    background: var(--ink);
  }
  .track i::after {
    content: "";
    position: absolute;
    right: -2px;
    top: -3px;
    width: 3px;
    height: 11px;
    background: var(--accent);
  }
  .compact .axis {
    grid-template-columns: 7.5rem 1fr;
    padding: 3px var(--s-3);
    box-shadow: none;
    border-left: 0;
    border-bottom: 1px dashed var(--line);
    transform: none;
    background: transparent;
  }
</style>
