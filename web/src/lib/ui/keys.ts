/** Горячие клавиши не перехватывают ввод в полях и работу с элементами управления. */
export function typing(e: KeyboardEvent) {
  return !!(e.target as HTMLElement)?.closest?.('input, select, textarea, [contenteditable="true"]');
}
export function modified(e: KeyboardEvent) {
  return e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey;
}
