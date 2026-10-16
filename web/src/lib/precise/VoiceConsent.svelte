<script lang="ts">
  // Согласие на запись голоса одним нажатием перед первым включением микрофона.
  // Отказ не мешает петь: остаётся оценка мелодии в браузере.
  let { busy = false, onaccept, ondecline }: { busy?: boolean; onaccept: () => void; ondecline: () => void } = $props();
</script>

<section class="voice-consent sheet" aria-labelledby="voice-consent-title">
  <h2 id="voice-consent-title">Точная оценка со словами</h2>
  <p>
    Пока ты поёшь, запись голоса уходит на компьютер команды в России: там проверяют мелодию и спетые слова. После оценки запись удаляется, не позднее чем через 10 минут.
    <a href="/legal/consent">Согласие на обработку данных</a>
  </p>
  <div class="actions">
    <button type="button" class="btn btn-primary" disabled={busy} onclick={onaccept}>Согласен, включить микрофон</button>
    <button type="button" class="btn btn-quiet" disabled={busy} onclick={ondecline}>Без точной оценки</button>
  </div>
</section>

<style>
  .voice-consent {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    font-size: var(--t-xs);
    line-height: 1.4;
  }
  h2 {
    margin: 0;
    font: 700 1.25rem/1.1 var(--font-hand);
  }
  p {
    margin: 0;
  }
  a {
    color: var(--accent);
    text-underline-offset: 2px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-3);
  }
  .actions .btn {
    min-height: 44px;
  }
  .btn-primary {
    font-size: 1.2rem;
  }
  @media (max-width: 599px) {
    .actions {
      flex-direction: column;
      align-items: stretch;
    }
  }
  @media (max-height: 520px) and (orientation: landscape) {
    .voice-consent {
      padding: var(--s-2) var(--s-3);
    }
  }
</style>
