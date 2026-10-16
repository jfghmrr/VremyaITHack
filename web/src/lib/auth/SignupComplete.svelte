<script lang="ts">
  // Первый вход через Яндекс ID или VK ID: сервер хранит ожидающую регистрацию 10 минут.
  // Кабинет создаётся только после согласия и указания возраста; имя в игре — нейтральное.
  import { completeSignup } from "#lib/api/account.svelte.ts";
  import AgeGroup from "./AgeGroup.svelte";
  import { ageProblem, parentNameFor, type AgeGroup as Group } from "./age.ts";

  let { token, oncomplete }: { token: string; oncomplete: () => void } = $props();
  let consent = $state(false);
  let ageGroup = $state("");
  let parentName = $state("");
  let parentConsent = $state(false);
  let sending = $state(false);
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = ageProblem(ageGroup, parentName, parentConsent);
    if (error) return;
    sending = true;
    try {
      await completeSignup(token, consent, ageGroup as Group, parentNameFor(ageGroup as Group, parentName));
      oncomplete();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<form class="signup sheet" onsubmit={submit} aria-labelledby="signup-title">
  <h2 id="signup-title">Завершение входа</h2>
  <p class="small">
    Ты впервые входишь через Яндекс ID или VK ID. Мы создадим кабинет с нейтральным именем в игре, его можно сменить в настройках. Настоящее имя и почту из сервиса мы не сохраняем.
  </p>
  <AgeGroup name="signup-age" bind:ageGroup bind:parentName bind:parentConsent />
  <label class="consent">
    <input type="checkbox" bind:checked={consent} required />
    <span>Даю <a href="/legal/consent" target="_blank">согласие на обработку персональных данных</a>. С <a href="/legal/privacy" target="_blank">политикой обработки данных</a> и <a href="/legal/terms" target="_blank">пользовательским соглашением</a> ознакомлен.</span>
  </label>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <button class="btn btn-primary" disabled={sending}>{sending ? "Создаём кабинет…" : "Завершить вход"}</button>
</form>

<style>
  .signup {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-6);
  }
  h2 {
    font: 700 1.9rem/1.1 var(--font-hand);
  }
  .consent {
    display: flex;
    gap: var(--s-2);
    align-items: start;
    font-size: var(--t-s);
  }
  .consent input {
    flex: none;
    width: 20px;
    height: 20px;
    margin-top: 1px;
    accent-color: var(--accent);
  }
  .consent a {
    color: var(--accent);
  }
  .btn-primary {
    justify-self: start;
    min-height: 44px;
  }
  @media (max-width: 599px) {
    .signup {
      padding: var(--s-5) var(--s-4);
    }
    .btn-primary {
      justify-self: stretch;
    }
  }
</style>
