<script lang="ts">
  // «Поделиться результатом»: бумажная карточка у кнопки (на телефоне — лист снизу экрана).
  // Не меняет раскладку страницы: панель прослушивания и кнопки попытки остаются на месте.
  // Закрывается крестиком, Esc и щелчком мимо. Ссылка копируется сразу; если буфер обмена
  // недоступен, ссылка выделяется в поле, и подсказка говорит, как скопировать вручную.
  import { onMount, tick } from "svelte";

  let {
    make,
    askName = false,
    name = $bindable(""),
    label = "Поделиться",
    placement = "below",
    variant = "btn btn-primary",
  }: {
    /** Строит ссылку-вызов; имя — из поля «Имя для вызова» (для гостя). */
    make: (name: string) => Promise<string>;
    askName?: boolean;
    name?: string;
    label?: string;
    /** side — справа от кнопки (на результате: поверх кота, не над кнопками попытки). */
    placement?: "below" | "above" | "side";
    variant?: string;
  } = $props();

  const uid = $props.id();
  let open = $state(false);
  let busy = $state(false);
  let link = $state("");
  let status = $state("");
  let failed = $state(false);
  let root: HTMLElement;
  let trigger: HTMLButtonElement;
  let field: HTMLInputElement | undefined = $state();
  let ticket = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function build(): Promise<boolean> {
    const t = ++ticket;
    busy = true;
    try {
      const next = await make(name);
      if (t !== ticket) return false;
      link = next;
      return true;
    } catch (e) {
      if (t !== ticket) return false;
      link = "";
      failed = true;
      status = (e as Error).message || "Не удалось создать ссылку. Попробуй ещё раз.";
      return false;
    } finally {
      if (t === ticket) busy = false;
    }
  }

  /**
   * writeText вызывается синхронно в обработчике нажатия «Скопировать» (до первого await):
   * iOS Safari разрешает буфер обмена только в самом жесте. Копирование без нажатия (при
   * открытии карточки, после смены имени) там не проходит: тогда auto — подсказка нажать
   * «Скопировать», без ошибки и без переноса фокуса из поля имени.
   */
  async function copy(done = "Ссылка скопирована", auto = "") {
    if (!link) return;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link);
      failed = false;
      status = done;
    } catch {
      if (auto) {
        failed = false;
        status = auto;
        return;
      }
      failed = true;
      status = "Не получилось скопировать автоматически. Ссылка выделена — скопируй её вручную.";
      await tick();
      field?.focus();
      field?.select();
    }
  }

  // Ссылка строится при открытии карточки; фокус — в поле ссылки (карточка-диалог получает фокус).
  async function show() {
    open = true;
    status = "";
    failed = false;
    const built = await build();
    if (!open) return;
    await tick();
    field?.focus();
    if (built) await copy("Ссылка скопирована", "Ссылка готова — нажми «Скопировать»");
  }

  function close(returnFocus = false) {
    open = false;
    clearTimeout(timer);
    if (returnFocus) trigger?.focus();
  }

  // Имя в вызове меняется — ссылка пересобирается и копируется заново.
  function rename() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (await build()) await copy("Ссылка обновлена и скопирована", "Ссылка обновлена — нажми «Скопировать»");
    }, 350);
  }

  onMount(() => {
    const down = (e: PointerEvent) => {
      if (open && root && !root.contains(e.target as Node)) close();
    };
    // Esc закрывает только карточку (страница результата по Esc уходит к песням).
    const key = (e: KeyboardEvent) => {
      if (open && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  });
</script>

<span class="share" bind:this={root}>
  <button bind:this={trigger} type="button" class={variant} aria-expanded={open} aria-controls="{uid}-panel" onclick={() => (open ? close() : void show())}>{label}</button>
  {#if open}
    <div class="panel sheet {placement}" id="{uid}-panel" role="dialog" aria-labelledby="{uid}-title">
      <div class="panel-head">
        <strong id="{uid}-title">Ссылка-вызов</strong>
        <button type="button" class="close" aria-label="Закрыть" onclick={() => close(true)}>×</button>
      </div>
      <p class="lead">Друг откроет ссылку и споёт против твоей попытки. Рейтинг не меняется.</p>
      {#if askName}
        <label class="field">
          <span>Имя для вызова</span>
          <input bind:value={name} maxlength="32" placeholder="Твоё имя" oninput={rename} />
        </label>
      {/if}
      <div class="row">
        <input bind:this={field} class="link mono" readonly value={busy && !link ? "Готовим ссылку…" : link} aria-label="Ссылка-вызов" onfocus={(e) => e.currentTarget.select()} />
        <button type="button" class="btn btn-ink copy" disabled={!link || busy} onclick={() => void copy()}>Скопировать</button>
      </div>
      <p class="status" class:failed role="status">{status}</p>
    </div>
  {/if}
</span>

<style>
  .share {
    position: relative;
    display: inline-flex;
  }
  .panel {
    position: absolute;
    z-index: 40;
    display: grid;
    gap: var(--s-2);
    width: min(400px, calc(100vw - 32px));
    padding: var(--s-4) var(--s-4) var(--s-3);
    text-align: left;
    box-shadow: var(--shadow-pop);
    rotate: -0.4deg;
  }
  /* Скотч сверху, как у записок на стене. */
  .panel::before {
    content: "";
    position: absolute;
    top: -11px;
    left: 50%;
    width: 84px;
    height: 22px;
    background: rgb(232 226 205 / 0.62);
    translate: -50% 0;
    rotate: -3deg;
  }
  .below {
    top: calc(100% + 14px);
    left: 50%;
    translate: -50% 0;
  }
  .above {
    bottom: calc(100% + 14px);
    right: 0;
  }
  .side {
    top: 50%;
    left: calc(100% + 16px);
    translate: 0 -50%;
  }
  /* Не wide: справа места нет — карточка под кнопкой. */
  @media not all and (min-width: 1100px) and (min-height: 521px) {
    .side {
      top: calc(100% + 14px);
      left: 50%;
      translate: -50% 0;
    }
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .panel-head strong {
    font: 700 1.6rem/1 var(--font-hand);
  }
  .close {
    display: grid;
    place-items: center;
    min-width: 36px;
    min-height: 36px;
    margin: -6px -8px 0 0;
    border: 0;
    background: none;
    color: var(--ink);
    font-size: 1.6rem;
    line-height: 1;
  }
  .lead {
    color: var(--ink-2);
    font-size: var(--t-s);
  }
  .field input {
    width: 100%;
  }
  .row {
    display: flex;
    gap: var(--s-2);
    align-items: stretch;
  }
  .link {
    flex: 1;
    min-width: 0;
    min-height: var(--control-h);
    padding: 0 var(--s-2);
    border: 0;
    border-bottom: 2px solid var(--ink);
    border-radius: 2px 2px 0 0;
    background: var(--paper);
    color: var(--ink);
    font-size: var(--t-xs);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.12);
  }
  .copy {
    flex: none;
  }
  .status {
    min-height: 1.3em;
    color: #2f6b3a;
    font-size: var(--t-s);
    font-weight: 600;
  }
  .status.failed {
    color: var(--accent);
  }
  @media (pointer: coarse), not all and (min-width: 1100px) and (min-height: 521px) {
    .close,
    .link {
      min-width: var(--tap);
      min-height: var(--tap);
    }
  }
  /* Телефон (и узкий планшет в портрете, где есть нижнее меню): лист снизу экрана поверх
     содержимого, а не карточка у кнопки. Учитывает вырезы экрана; на низком ландшафте (около
     390 px) не выше окна и прокручивается внутри. */
  @media (max-width: 599px), (max-height: 520px) and (orientation: landscape), (max-width: 799px) and (min-height: 521px) {
    .panel,
    .below,
    .above,
    .side {
      position: fixed;
      top: auto;
      left: calc(var(--s-2) + var(--safe-left));
      right: calc(var(--s-2) + var(--safe-right));
      width: auto;
      /* В портрете — над нижним меню (--bar-space задаёт routes/+layout.svelte только там). */
      bottom: calc(var(--s-2) + var(--bar-space, var(--safe-bottom)));
      max-height: calc(100dvh - var(--safe-top) - var(--bar-space, var(--safe-bottom)) - 2 * var(--s-2));
      overflow-y: auto;
      overscroll-behavior: contain;
      translate: none;
      rotate: 0deg;
    }
    /* Прокручиваемый лист обрезает выступающее: скотч — полоска у верхнего края. */
    .panel::before {
      top: 0;
      height: 12px;
    }
  }
</style>
