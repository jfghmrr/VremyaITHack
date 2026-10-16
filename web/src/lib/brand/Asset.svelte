<script lang="ts">
  let { name, alt = "", width = "100%" }: { name: string; alt?: string; width?: string | number } = $props();
</script>
<img class="cutout-asset" src="/art/{name}.webp?v=restored-1" {alt} draggable="false" style:width={typeof width === "number" ? `${width}px` : width} />
<style>.cutout-asset { display: block; max-width: 100%; height: auto; object-fit: contain; user-select: none; }</style>
