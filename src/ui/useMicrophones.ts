import { useCallback, useEffect, useState } from "react";
const STORAGE_KEY = "echo.inputDeviceId";
export function useMicrophones() {
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [listError, setListError] = useState("");
  const refresh = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput" && d.deviceId,
        ),
      );
      setListError("");
    } catch {
      setListError(
        "Не удалось обновить список входов. Проверь разрешение на микрофон.",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  function choose(id: string) {
    setSelected(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      setListError(
        "Выбор сохранён только до закрытия вкладки: локальное хранилище недоступно.",
      );
    }
  }
  return { selected, devices, listError, refresh, choose };
}
