<script lang="ts">
  import { artDims, PHONE_BLANK } from "./art";
  import { PHONE_QUERY } from "#lib/ui/stage.svelte.ts";
  // Декор грузится лениво; первый экран (логотип, кресло, магнитофон) передаёт loading="eager".
  // skipOnPhone: картинка комнаты, скрытой на телефоне в портрете (главная), — там браузер берёт
  // пустой источник и не скачивает файл; на остальных раскладках разметка и загрузка прежние.
  let { name, alt = "", width = "100%", loading = "lazy", skipOnPhone = false }: { name: string; alt?: string; width?: string | number; loading?: "lazy" | "eager"; skipOnPhone?: boolean } = $props();
</script>
{#if skipOnPhone}
  <picture class="phone-skip"><source media={PHONE_QUERY} srcset={PHONE_BLANK} /><img class="cutout-asset" src="/art/{name}.webp?v=web-1" {alt} {...artDims(name)} {loading} draggable="false" style:width={typeof width === "number" ? `${width}px` : width} /></picture>
{:else}
  <img class="cutout-asset" src="/art/{name}.webp?v=web-1" {alt} {...artDims(name)} {loading} draggable="false" style:width={typeof width === "number" ? `${width}px` : width} />
{/if}
<style>.cutout-asset { display: block; max-width: 100%; height: auto; object-fit: contain; user-select: none; } .phone-skip { display: contents; }</style>
