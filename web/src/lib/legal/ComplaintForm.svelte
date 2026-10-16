<script lang="ts">
  // Обращение к оператору: вопросы о данных, отзыв согласия, жалобы на материалы и заявки
  // правообладателей. Хранится на сервере; по обоснованной заявке материал блокируется и удаляется
  // (ст. 1253.1 ГК РФ, ст. 15.7 149-ФЗ). Ссылка нужна только для обращения о материале.
  import { api } from "#lib/api/http.ts";

  const LIMIT = 2000;
  let name = $state("");
  let email = $state("");
  let url = $state("");
  let text = $state("");
  let sending = $state(false);
  let error = $state("");
  let sent = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    sending = true;
    try {
      await api("complaints", { method: "POST", body: { name: name.trim(), email: email.trim(), url: url.trim(), text: text.trim() } });
      sent = true;
      name = email = url = text = "";
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<form class="complaint" onsubmit={submit} aria-labelledby="complaint-title">
  <h2 id="complaint-title">Обращение к оператору</h2>
  <p>Напишите вопрос о данных, отзыв согласия или жалобу. Если обращение о материале, например заявка правообладателя, укажите ссылку на него: обоснованно оспоренный материал мы заблокируем. Ответим на указанную почту.</p>
  <label class="field">Ваше имя или организация<input bind:value={name} required maxlength={LIMIT} autocomplete="name" /></label>
  <label class="field">Почта для ответа<input type="email" bind:value={email} required maxlength={LIMIT} autocomplete="email" /></label>
  <label class="field">Ссылка на материал <span class="hint">— если обращение о материале</span><input type="url" bind:value={url} maxlength={LIMIT} placeholder="https://…" /></label>
  <label class="field">Суть обращения<textarea bind:value={text} required maxlength={LIMIT} rows="5"></textarea></label>
  <p class="small">Данные обращения используются только для его рассмотрения и ответа.</p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if sent}<p class="notice" role="status">Заявка отправлена. Мы ответим на указанную почту.</p>{/if}
  <button class="btn btn-primary" disabled={sending}>{sending ? "Отправляем…" : "Отправить заявку"}</button>
</form>

<style>
  .complaint {
    display: grid;
    gap: var(--s-3);
    margin-top: var(--s-5);
    padding-top: var(--s-4);
    border-top: 1px dashed var(--line-strong);
  }
  .complaint h2 {
    margin-top: 0;
  }
  .hint {
    color: var(--ink-2);
    font-size: var(--t-xs);
  }
  textarea {
    min-height: 120px;
    padding: var(--s-2) var(--s-3);
    border: 0;
    border-bottom: 2px solid var(--ink);
    border-radius: 2px 2px 0 0;
    background: var(--paper-2);
    color: var(--ink);
    font: inherit;
    font-size: var(--t-m);
    resize: vertical;
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.12);
  }
  .field input {
    min-height: 44px;
  }
  .btn-primary {
    justify-self: start;
    min-height: 44px;
  }
  @media (max-width: 599px) {
    .btn-primary {
      justify-self: stretch;
    }
  }
</style>
