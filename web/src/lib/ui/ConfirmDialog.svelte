<script lang="ts">
  // Модальный диалог на нативном <dialog>: фокус внутри, Esc — отмена, Enter — подтверждение.
  let {
    open,
    title,
    text,
    confirm,
    cancel = "Продолжить",
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    title: string;
    text: string;
    confirm: string;
    cancel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let confirmButton: HTMLButtonElement;
  $effect(() => {
    if (open && !dialog.open) {
      dialog.showModal();
      // Enter подтверждает, Esc отменяет: фокус на кнопке подтверждения.
      confirmButton.focus();
    }
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="dialog-title"
  oncancel={(e) => {
    e.preventDefault();
    oncancel();
  }}
  onkeydown={(e) => {
    if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      onconfirm();
    }
  }}
>
  <h2 id="dialog-title">{title}</h2>
  <p>{text}</p>
  <div class="actions">
    <button class="btn" onclick={oncancel}>{cancel} <kbd>Esc</kbd></button>
    <button class="btn btn-primary" bind:this={confirmButton} onclick={onconfirm}>{confirm} <kbd>Enter</kbd></button>
  </div>
</dialog>

<style>
  /* Диалог — лист бумаги на скотче поверх затемнённой комнаты. */
  dialog {
    width: min(460px, calc(100vw - 32px));
    padding: var(--s-6);
    overflow: visible;
    border: 0;
    border-radius: 2px;
    background: var(--paper-2) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-pop);
  }
  dialog::before {
    content: "";
    position: absolute;
    left: 50%;
    top: -12px;
    width: 104px;
    height: 26px;
    background: rgb(232 226 205 / 0.6);
    transform: translateX(-50%) rotate(-2deg);
  }
  dialog[open] {
    animation: drop var(--d-slow) var(--ease-heavy);
  }
  @keyframes drop {
    from {
      transform: translateY(-14px) rotate(-1.5deg);
      opacity: 0;
    }
  }
  dialog::backdrop {
    background: rgb(10 10 11 / 0.7);
  }
  h2 {
    font-family: var(--font-hand);
    font-size: 2rem;
    letter-spacing: 0;
    margin-bottom: var(--s-3);
  }
  p {
    color: var(--ink-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-3);
    margin-top: var(--s-6);
  }
  .btn-primary kbd {
    font-family: var(--font-mono);
    font-size: 0.6em;
  }
</style>
