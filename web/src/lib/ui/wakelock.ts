// Экран телефона не гаснет, пока человек поёт: Screen Wake Lock там, где он есть.
// Браузер сам снимает блокировку, когда вкладка уходит в фон, поэтому при возврате
// она запрашивается снова, пока пение не остановлено. Отказ браузера (энергосбережение,
// политика сайта) не мешает пению. Возвращает функцию освобождения; повторный вызов безопасен.
export async function acquireWakeLock(): Promise<() => void> {
  const api = typeof navigator !== "undefined" && "wakeLock" in navigator ? navigator.wakeLock : undefined;
  if (!api || typeof api.request !== "function" || typeof document === "undefined") return () => {};
  let active = true;
  let sentinel: WakeLockSentinel | null = null;
  const request = async () => {
    try {
      const next = await api.request("screen");
      if (active) sentinel = next;
      else void next.release().catch(() => {});
    } catch {
      /* Нет разрешения или вкладка не видна: экран может погаснуть, пение продолжается. */
    }
  };
  const onVisibility = () => {
    if (active && document.visibilityState === "visible" && (!sentinel || sentinel.released)) void request();
  };
  document.addEventListener("visibilitychange", onVisibility);
  await request();
  return () => {
    if (!active) return;
    active = false;
    document.removeEventListener("visibilitychange", onVisibility);
    const held = sentinel;
    sentinel = null;
    if (held && !held.released) void held.release().catch(() => {});
  };
}
