<script lang="ts">
  import Star from "./Star.svelte";
  import Asset from "./Asset.svelte";
  let { text, tag = "h1", id, pin = false, fastener = "paperclip" }: { text: string; tag?: "h1" | "h2" | "div"; id?: string; pin?: boolean; fastener?: "star" | "paperclip" | "binder" } = $props();
</script>

<div class="strip">
  <span class="star" class:hardware={pin || fastener !== "star"} aria-hidden="true">{#if fastener === "binder"}<Asset name="hardware/binder-clip-s03" width={35} />{:else if pin || fastener === "paperclip"}<Asset name="hardware/paperclip-s02" width={24} />{:else}<Star variant="patch" size={44} />{/if}</span>
  <svelte:element this={tag} class="text" {id}>{text}</svelte:element>
</div>

<style>
  .strip {
    position: relative;
    display: inline-block;
    align-self: start;
    justify-self: start;
    padding: 15px 38px 20px;
    min-width: 220px;
    text-align: center;
    transform: rotate(-1.5deg);
    filter: drop-shadow(0 4px 6px rgb(0 0 0 / 0.55));
  }
  .strip::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--paper) var(--tex-paper);
    clip-path: polygon(0 5%,19% 2%,47% 4%,78% 0,100% 3%,98% 55%,100% 95%,72% 98%,50% 96%,22% 100%,0 96%,1% 53%);
    
  }
  .text {
    margin: 0;
    color: var(--ink);
    font-family: var(--font-hand);
    font-size: clamp(1.9rem, 2.6vw, 2.35rem);
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .hardware { left: 14px !important; top: -24px !important; }
  .star {
    position: absolute;
    left: -20px;
    top: -18px;
    transform: rotate(-12deg);
  }
</style>
