<script lang="ts">
  // Возраст при регистрации любым способом: 14+ или младше 14 с разрешением родителя.
  let {
    ageGroup = $bindable(""),
    parentName = $bindable(""),
    parentConsent = $bindable(false),
    name,
  }: { ageGroup?: string; parentName?: string; parentConsent?: boolean; name: string } = $props();
</script>

<fieldset class="age-group">
  <legend>Возраст</legend>
  <div class="choices">
    <label class="choice"><input type="radio" {name} value="14plus" bind:group={ageGroup} required /><span>Мне 14 лет или больше</span></label>
    <label class="choice"><input type="radio" {name} value="under14" bind:group={ageGroup} /><span>Мне меньше 14 лет</span></label>
  </div>
  {#if ageGroup === "under14"}
    <label class="choice parent-ok">
      <input type="checkbox" bind:checked={parentConsent} required />
      <span>Родитель или законный представитель разрешает мне регистрацию и даёт согласие за меня</span>
    </label>
    <label class="field">Имя родителя или законного представителя<input bind:value={parentName} maxlength="64" autocomplete="off" /></label>
  {/if}
</fieldset>

<style>
  .age-group {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--s-1);
    padding: 0;
    font-size: var(--t-s);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--s-4);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 44px;
    font-size: var(--t-s);
    cursor: pointer;
  }
  .choice input {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--accent);
  }
  .parent-ok {
    align-items: start;
    padding-top: var(--s-2);
  }
  .parent-ok input {
    margin-top: 1px;
  }
  @media (max-width: 599px) {
    .choices {
      display: grid;
    }
  }
</style>
