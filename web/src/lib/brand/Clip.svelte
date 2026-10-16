<script lang="ts">
  // Канцелярская скрепка, охватывающая край листа: задняя петля темнее и уходит под бумагу.
  let { size = 22, rotate = 0 }: { size?: number; rotate?: number } = $props();
</script>

<svg class="clip" viewBox="0 0 22 60" width={size} height={size * (60 / 22)} style:rotate="{rotate}deg" aria-hidden="true">
  <path d="M7 40 V8 a4 4 0 0 1 8 0 V44" fill="none" stroke="#5d5c58" stroke-width="2.2" stroke-linecap="round" />
  <path d="M15 44 a6 6 0 0 1 -12 0 V12 a8 8 0 0 1 16 0 V50" fill="none" stroke="#c9c8c2" stroke-width="2.4" stroke-linecap="round" />
  <path d="M5 16 V44" stroke="#efeee8" stroke-width="0.8" stroke-linecap="round" opacity="0.8" />
</svg>

<style>
  .clip {
    display: block;
    overflow: visible;
    filter: drop-shadow(1px 2px 1px rgb(0 0 0 / 0.45));
  }
</style>
