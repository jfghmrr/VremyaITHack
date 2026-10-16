// Режим звука на проверке микрофона запоминается в браузере.
import type { PlayMode } from "./uploader.ts";

const KEY = "perepev.playMode";

export function loadPlayMode(): PlayMode {
  try {
    return localStorage.getItem(KEY) === "speaker" ? "speaker" : "headphones";
  } catch {
    return "headphones";
  }
}

export function savePlayMode(mode: PlayMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* хранилище недоступно: выбор действует до перезагрузки */
  }
}
