<script lang="ts">
  // Возрастная маркировка (436-ФЗ): знак сайта в подвале и знак песни на карточке.
  let { age = "0+", size = "s" }: { age?: string; size?: "s" | "m" } = $props();
</script>

<span class="age-badge {size}" role="img" aria-label="Возрастная маркировка {age}" title="Возрастная маркировка {age}">{age}</span>

<style>
  .age-badge {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: 2.3em;
    padding: 0.08em 0.35em;
    border: 1px solid currentColor;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .age-badge.m {
    font-size: 0.72rem;
  }
</style>
