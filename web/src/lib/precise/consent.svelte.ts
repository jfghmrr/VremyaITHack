// Согласие на обработку записи голоса для точной оценки. Спрашивается одним нажатием перед
// первым включением микрофона, у гостя и у пользователя кабинета, заново — при новой редакции
// согласия. Хранится в этом браузере; сервер получает версию с каждой записью (POST /api/perf).
import { documents } from "#lib/legal/operator.ts";

const KEY = "perepev.voiceConsent";

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === documents.consent;
  } catch {
    return false;
  }
}

export const voiceConsent = $state({ given: false });

/** Чтение при открытии экрана: хранилище недоступно при пререндере. */
export function loadVoiceConsent() {
  voiceConsent.given = stored();
  return voiceConsent.given;
}

export function giveVoiceConsent() {
  voiceConsent.given = true;
  try {
    localStorage.setItem(KEY, documents.consent);
  } catch {
    /* хранилище недоступно: согласие действует до перезагрузки вкладки */
  }
}
