import { describe, expect, it } from "vitest";
import { REOPEN_GUARD_MS, menuHistory } from "../src/lib/ui/menu-history";

/** История с одной записью меню поверх страницы: back() снимает её только после «popstate». */
function fakeHistory() {
  const log: string[] = [];
  const nav = deferred();
  let open = false;
  const clock = { t: 0 };
  return {
    log,
    clock,
    setOpen: (v: boolean) => (open = v),
    h: {
      now: () => clock.t,
      isOpen: () => open,
      push: () => {
        log.push("push");
        open = true;
      },
      back: () => log.push("back"),
      replace: (href: string) => {
        log.push(`replace ${href}`);
        return nav.promise;
      },
    },
    nav,
  };
}

function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((y, n) => ((resolve = y), (reject = n)));
  return { promise, resolve, reject };
}

describe("меню разделов в истории браузера", () => {
  it("открывается одной записью", () => {
    const f = fakeHistory();
    const m = menuHistory(f.h);
    m.open();
    m.open();
    expect(f.log).toEqual(["push"]);
  });

  it("крестик дважды, Esc и следом close — один шаг «Назад», пока popstate не обработан", () => {
    const f = fakeHistory();
    const m = menuHistory(f.h);
    m.open();
    m.close();
    m.close();
    m.close();
    expect(f.log).toEqual(["push", "back"]);
    // SvelteKit обработал popstate: запись ушла, меню снова открывается и закрывается.
    f.setOpen(false);
    m.closed();
    m.close();
    expect(f.log).toEqual(["push", "back"]);
    // Второе касание двойного нажатия на «×» попадает в кнопку «Меню» под ним: меню не открывается.
    f.clock.t += 50;
    m.open();
    expect(f.log).toEqual(["push", "back"]);
    f.clock.t += REOPEN_GUARD_MS;
    m.open();
    m.close();
    expect(f.log).toEqual(["push", "back", "push", "back"]);
  });

  for (const outcome of ["отменён", "не удался"] as const)
    it(`переход из меню ${outcome}: пока он идёт, «Назад» не уходит; потом меню закрывается как обычно`, async () => {
      const f = fakeHistory();
      const m = menuHistory(f.h);
      m.open();
      const going = m.follow("/leaders");
      expect(m.leaving).toBe(true);
      m.close();
      void m.follow("/songs");
      expect(f.log).toEqual(["push", "replace /leaders"]);
      // beforeNavigate отменил переход (goto завершился, а запись меню осталась текущей) или goto упал.
      if (outcome === "отменён") f.nav.resolve();
      else f.nav.reject(new Error("сбой загрузки"));
      await going;
      expect(m.leaving).toBe(false);
      m.close();
      expect(f.log).toEqual(["push", "replace /leaders", "back"]);
    });
});
