<script lang="ts">
  // Стрелочный индикатор уровня, как на магнитофоне: шкала 0–100 с подписями,
  // красная зона перегруза. Значение дублируется цифрами — показания различимы без цвета.
  let { value, label = "Уровень микрофона" }: { value: number; label?: string } = $props();

  const ticks = [0, 20, 40, 60, 80, 100];
  const angle = (v: number) => -48 + (Math.min(100, Math.max(0, v)) / 100) * 96;
  const at = (v: number, r: number) => {
    const a = ((angle(v) - 90) * Math.PI) / 180;
    return [100 + r * Math.cos(a), 108 + r * Math.sin(a)];
  };
  const arc = (from: number, to: number, r: number) => {
    const [x1, y1] = at(from, r);
    const [x2, y2] = at(to, r);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
</script>

<div class="vu" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(value)}>
  <svg viewBox="0 0 200 116" aria-hidden="true">
    <rect x="1" y="1" width="198" height="114" rx="6" fill="#efe4c4" stroke="#2a2826" stroke-width="2" />
    <path d={arc(0, 80, 78)} fill="none" stroke="#1f1c1a" stroke-width="1.6" />
    <path d={arc(80, 100, 78)} fill="none" stroke="#a81d1d" stroke-width="5" />
    {#each Array.from({ length: 21 }, (_, i) => i * 5) as v (v)}
      {@const [x1, y1] = at(v, 78)}
      {@const [x2, y2] = at(v, v % 20 === 0 ? 68 : 73)}
      <line {x1} {y1} {x2} {y2} stroke={v >= 80 ? "#a81d1d" : "#1f1c1a"} stroke-width={v % 20 === 0 ? 1.8 : 1} />
    {/each}
    {#each ticks as v (v)}
      {@const [x, y] = at(v, 90)}
      <text {x} y={y + 3} text-anchor="middle" class="num" fill={v >= 80 ? "#a81d1d" : "#1f1c1a"}>{v}</text>
    {/each}
    <text x="100" y="80" text-anchor="middle" class="vu-l">VU</text>
    <g class="needle" style:transform="rotate({angle(value)}deg)">
      <line x1="100" y1="108" x2="100" y2="34" stroke="#1f1c1a" stroke-width="1.8" stroke-linecap="round" />
    </g>
    <rect x="62" y="100" width="76" height="16" fill="#2a2826" />
    <circle cx="100" cy="108" r="5" fill="#2a2826" />
    <rect x="9" y="91" width="38" height="17" rx="2" fill="#2a2826" />
    <text x="28" y="103.5" text-anchor="middle" class="value">{Math.round(value)}</text>
  </svg>
</div>

<style>
  .vu {
    position: relative;
    display: block;
    padding: 6px;
    border-radius: 8px;
    background: linear-gradient(#4b4a47, #2b2a28);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.2),
      0 6px 14px -6px rgb(0 0 0 / 0.7);
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .num {
    font-family: var(--font-mono);
    font-size: 9px;
  }
  .vu-l {
    font-family: var(--font-poster);
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.1em;
    fill: #1f1c1a;
  }
  .needle {
    transform-box: view-box;
    transform-origin: 100px 108px;
    transition: transform 90ms linear;
  }
  .value {
    font-family: var(--font-mono);
    font-size: 11px;
    fill: #efe4c4;
  }
</style>
