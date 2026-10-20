<script lang="ts">
  // «Вместе»: подсказка перед каждым ходом — «Сейчас поёшь ты» (красным) или «Сейчас поёт {имя}»
  // (синим), за CUE_LEAD_S до начала хода и немного после. Время читается в requestAnimationFrame,
  // как в полосе слов, а не реактивно. Ход из расписания сервера, клиент его не пересчитывает.
  import { onMount } from "svelte";
  import type { Turn } from "#lib/api/types.ts";
  import { cueAt } from "./coop.ts";

  let { turns, slot, partner, time }: { turns: Turn[]; slot: number; partner: string; time: () => number } = $props();

  let cue = $state<{ turn: number; mine: boolean } | null>(null);
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const next = cueAt(turns, slot, time());
      if (next?.turn !== cue?.turn) cue = next;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="cue-live" aria-live="polite">
  {#if cue}
    <p class="cue" class:mine={cue.mine} class:partner={!cue.mine}>
      {cue.mine ? "Сейчас поёшь ты" : `Сейчас поёт ${partner}`}
    </p>
  {/if}
</div>

<style>
  .cue-live {
    position: absolute;
    top: var(--s-3);
    left: 50%;
    translate: -50% 0;
    z-index: 2;
    pointer-events: none;
    max-width: calc(100% - var(--s-6));
  }
  .cue {
    margin: 0;
    padding: 0.2em 0.8em 0.3em;
    border-radius: 4px;
    color: var(--paper-2);
    font-family: var(--font-hand);
    font-size: clamp(1.5rem, 2.6vw, 2.4rem);
    font-weight: 700;
    line-height: 1.1;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    rotate: -1.5deg;
    box-shadow: var(--shadow-sticker), 0 6px 14px rgb(0 0 0 / 0.35);
    animation: cue-in 0.25s ease-out;
  }
  .cue.mine {
    background: var(--accent);
  }
  .cue.partner {
    background: var(--rival);
  }
  @keyframes cue-in {
    from {
      opacity: 0;
      scale: 0.92;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cue {
      animation: none;
    }
  }
  @media (max-height: 520px) {
    .cue-live {
      top: var(--s-1);
    }
    .cue {
      font-size: 1.3rem;
    }
  }
</style>
