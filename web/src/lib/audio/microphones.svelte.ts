// Список входов и сохранённый выбор (только идентификатор устройства, без записи).
const KEY = "perepev.inputDeviceId";
const OLD_KEY = "echo.inputDeviceId";

export const mics = $state<{ selected: string; devices: MediaDeviceInfo[]; error: string }>({
  selected: "",
  devices: [],
  error: "",
});

export function initMics() {
  try {
    mics.selected = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? "";
  } catch {
    /* хранилище недоступно */
  }
  void refreshMics();
  navigator.mediaDevices?.addEventListener("devicechange", refreshMics);
  return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshMics);
}

export async function refreshMics() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    mics.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
    mics.error = "";
  } catch {
    mics.error = "Не удалось обновить список входов. Проверь разрешение на микрофон.";
  }
}

export function chooseMic(id: string) {
  mics.selected = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    mics.error = "Выбор сохранится только до закрытия вкладки: локальное хранилище недоступно.";
  }
}
