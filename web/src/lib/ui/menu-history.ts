// Меню разделов на телефоне живёт в истории браузера: открытие — неглубокая навигация
// (page.state.menu), закрытие — шаг «Назад». Здесь только порядок шагов, без Svelte и DOM,
// чтобы его можно было проверить отдельно (tests/menu-history.test.ts).
export interface MenuHistory {
  /** Запись «меню открыто» — текущая (page.state.menu === true). */
  isOpen(): boolean;
  /** goto("", { shallow: true, state: { menu: true } }). */
  push(): void;
  /** history.back(). */
  back(): void;
  /** goto(href, { replace: true }): новая страница заменяет запись меню. */
  replace(href: string): Promise<unknown>;
  /** Часы в мс (performance.now). */
  now?(): number;
}

/** Сколько после закрытия крестиком, Esc или касанием мимо меню не открывается снова: второе
 *  касание двойного нажатия на «×» попадает в кнопку «Меню» под ним (она на том же месте). */
export const REOPEN_GUARD_MS = 450;

export function menuHistory(h: MenuHistory) {
  // «Назад» уже отправлен, а SvelteKit ещё не обработал popstate: page.state.menu пока true.
  let closing = false;
  // Идёт переход по ссылке из меню: лист остаётся открытым, пока переход не закончится.
  let leaving = false;
  let closedAt = -Infinity;
  const now = () => (h.now ?? (() => performance.now()))();
  return {
    get leaving() {
      return leaving;
    },
    open() {
      if (h.isOpen() || now() - closedAt < REOPEN_GUARD_MS) return;
      h.push();
    },
    /** Ровно один шаг «Назад», сколько бы раз ни сработали крестик, Esc, касание мимо листа
     *  или событие close (Esc без свежего касания, системная «Назад» Android закрывают <dialog>
     *  без cancel). Иначе второй шаг уводил со страницы. */
    close() {
      if (!h.isOpen() || closing || leaving) return;
      closing = true;
      h.back();
    },
    /** Запись меню ушла из истории (page.state.menu снова пуст). */
    closed() {
      if (closing) closedAt = now();
      closing = false;
    },
    /** Переход из меню. Если его отменили (beforeNavigate живого матча) или он не удался,
     *  запись меню остаётся текущей: меню открыто и закрывается обычным путём, а не висит
     *  с aria-expanded=true без листа и с неработающей кнопкой. */
    async follow(href: string) {
      if (leaving || closing) return;
      leaving = true;
      try {
        await h.replace(href);
      } catch {
        // Ошибку показывает сама страница; меню остаётся в согласованном состоянии.
      } finally {
        leaving = false;
      }
    },
  };
}
