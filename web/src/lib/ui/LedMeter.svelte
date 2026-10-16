<script lang="ts">
  // Индикатор уровня как на деке: десять сегментов, зелёные — норма, жёлтые — громко,
  // красные — перегруз. Значение продублировано цифрами.
  let { value, label = "Уровень микрофона" }: { value: number; label?: string } = $props();
  const lit = $derived(Math.round(Math.min(100, Math.max(0, value)) / 10));
</script>

<div class="led" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(value)}>
  <div class="bars" aria-hidden="true">
    {#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
      <i class:on={i < lit} class={i >= 8 ? "red" : i >= 6 ? "yellow" : "green"} style:height="{38 + i * 6}%"></i>
    {/each}
  </div>
  <span class="num mono">{Math.round(value)}</span>
</div>

<style>
  .led {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 12px;
    height: 100%;
    min-height: 96px;
    padding: 14px 16px 12px;
    border-radius: 6px;
    background: linear-gradient(#232224, #141314);
    box-shadow:
      inset 0 2px 6px rgb(0 0 0 / 0.8),
      0 0 0 4px #39373a,
      0 10px 20px -8px rgb(0 0 0 / 0.8);
  }
  .bars {
    display: flex;
    align-items: flex-end;
    gap: 5px;
    height: 100%;
  }
  i {
    flex: 1;
    border-radius: 1px;
    opacity: 0.18;
    transition: opacity 80ms linear;
  }
  i.on {
    opacity: 1;
  }
  .green {
    background: #5fb35a;
  }
  .yellow {
    background: #e0b437;
  }
  .red {
    background: #d8453c;
  }
  .num {
    color: var(--on-room-2);
    font-size: var(--t-xs);
  }
</style>
