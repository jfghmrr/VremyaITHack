<script lang="ts">
  // Полароид: белая рамка с широким нижним полем, внутри — что угодно.
  import type { Snippet } from "svelte";
  let { children, caption = "", dark = true }: { children?: Snippet; caption?: string; dark?: boolean } = $props();
</script>

<span class="polaroid">
  <span class="frame" class:dark>{@render children?.()}</span>
  {#if caption}<span class="cap">{caption}</span>{/if}
</span>

<style>
  .polaroid {
    display: grid;
    width: 100%;
    padding: 7% 7% 0;
    background: #f1ece1 var(--tex-paper);
    box-shadow:
      0 2px 2px rgb(0 0 0 / 0.5),
      0 14px 22px -10px rgb(0 0 0 / 0.9);
  }
  .frame {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    overflow: hidden;
    background: #d9d3c6;
  }
  .frame.dark {
    background: radial-gradient(circle at 50% 35%, #4a4644, #1c1b1c 75%);
  }
  .cap {
    padding: 6% 2% 9%;
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 1;
    text-align: center;
  }
  .polaroid:not(:has(.cap)) {
    padding-bottom: 22%;
  }
</style>
