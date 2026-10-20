<script lang="ts">
  // Пометка у балла: «предварительно», пока компьютер команды проверяет запись, затем
  // «слова проверены» или «слова не проверены» и объяснение ограничения балла.
  import { pendingNote, precise } from "./attempt.svelte.ts";

  const cap = $derived(precise.result?.cap ?? null);
</script>

<div class="precise" role="status" aria-live="polite">
  {#if precise.status === "pending"}
    <span class="badge pending">предварительно</span><span class="checking">{pendingNote(precise.wordsCheck)}</span>
  {:else if precise.result?.wordsChecked}
    <span class="badge checked">слова проверены</span>
  {:else}
    <span class="badge">слова не проверены</span>
  {/if}
  {#if cap === "bleed"}
    <!-- Спецификация §5.6: надеть наушники или сменить режим. В «В наушниках» без наушников
         играет голос-подсказка — помогает режим «Без наушников»; в нём голос попадает в запись
         только у песни без отдельного минуса — тогда нужны наушники и «В наушниках». -->
    <p class="cap">
      {precise.mode === "speaker"
        ? "Похоже, голос исполнителя из динамика попал в запись. Надень наушники и выбери режим «В наушниках»."
        : "Похоже, голос исполнителя звучал из динамика. Надень наушники или выбери режим «Без наушников»: тогда играет только минус."}
    </p>
  {:else if cap === "words"}
    <p class="cap">Почти не слышно слов</p>
  {/if}
</div>

<style>
  .precise {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--s-1) var(--s-2);
    max-width: 100%;
    font-size: var(--t-xs);
    text-align: center;
  }
  .badge {
    padding: 2px var(--s-2);
    border: 1.5px solid currentColor;
    border-radius: 3px;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-weight: 500;
    rotate: -1.5deg;
  }
  .pending {
    color: var(--accent);
  }
  .checked {
    color: #2f6b3a;
  }
  .checking {
    color: var(--ink-2);
  }
  .cap {
    flex-basis: 100%;
    margin: 0;
    color: var(--accent);
    font-weight: 600;
  }
  @media (max-width: 599px) {
    .precise {
      font-size: var(--t-s);
    }
  }
</style>
