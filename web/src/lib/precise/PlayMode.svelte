<script lang="ts">
  // Режим звука на проверке микрофона: «В наушниках» — минус и тихий голос-подсказка,
  // «Без наушников» — только минус и эхоподавление, чтобы песня из динамика не попала в оценку.
  import type { PlayMode } from "./uploader.ts";

  let { mode, stems, disabled = false, onchange }: { mode: PlayMode; stems: boolean; disabled?: boolean; onchange: (mode: PlayMode) => void } = $props();

  const hint = $derived(
    mode === "headphones"
      ? stems
        ? "Звучат минус и тихий голос исполнителя как подсказка."
        : "Звучит запись с голосом исполнителя."
      : stems
        ? "Звучит только минус, эхо приглушается."
        : "Эхо приглушается, но голос исполнителя из динамика может попасть в запись. Лучше надеть наушники.",
  );
</script>

<div class="play-mode sheet">
  <div class="choice" role="group" aria-label="Как слушать песню">
    <button type="button" aria-pressed={mode === "headphones"} {disabled} onclick={() => mode !== "headphones" && onchange("headphones")}>В наушниках</button>
    <button type="button" aria-pressed={mode === "speaker"} {disabled} onclick={() => mode !== "speaker" && onchange("speaker")}>Без наушников</button>
  </div>
  <p class="hint">{hint}</p>
</div>

<style>
  .play-mode {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
  }
  .choice {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 2px solid var(--ink);
    border-radius: 3px;
  }
  .choice button {
    min-height: 44px;
    padding: 0 var(--s-3);
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--t-s);
    font-weight: 600;
    line-height: 1.1;
  }
  .choice button + button {
    border-left: 2px solid var(--ink);
  }
  .choice button[aria-pressed="true"] {
    background: var(--ink);
    color: var(--paper-2);
  }
  .choice button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }
  .hint {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--t-xs);
    line-height: 1.35;
  }
  /* compact и short: плотнее, чтобы «Начать пение» оставалась в первом экране телефона. */
  @media (max-width: 599px), (max-height: 520px) and (orientation: landscape) {
    .play-mode {
      gap: 6px;
      padding: 6px var(--s-2);
    }
  }
</style>
