// Запуск функции внутри $effect (как в $effect страниц дуэлей) со счётчиком перезапусков.
export function inEffect(fn: () => void) {
  let runs = 0;
  const stop = $effect.root(() => {
    $effect(() => {
      runs++;
      fn();
    });
  });
  return { runs: () => runs, stop };
}
