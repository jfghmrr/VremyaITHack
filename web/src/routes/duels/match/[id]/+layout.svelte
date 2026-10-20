<script lang="ts">
  // Экран матча держит состояние одного матча (запланированный старт, отправленные точки,
  // итоговые кривые). SvelteKit при переходе /duels/match/<a> → /duels/match/<b> (например,
  // «Назад» в браузере с реванша) переиспользует компонент страницы, поэтому для другого матча
  // страница создаётся заново.
  import { page } from "$app/state";

  let { children } = $props();
</script>

{#key page.params.id}
  {@render children()}
{/key}
