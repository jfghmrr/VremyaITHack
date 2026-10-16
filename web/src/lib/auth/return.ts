// Куда вернуться после входа через Яндекс ID или VK ID: только путь этого сайта.
// Правила те же, что у safe_return на сервере (crates/api/src/oauth.rs), который проверяет ещё раз.

const FALLBACK = "/account";

export function safeReturn(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return FALLBACK;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x21 || code > 0x7e || ch === "\\") return FALLBACK;
  }
  const path = value.split(/[?#]/)[0];
  return path === "/api" || path.startsWith("/api/") ? FALLBACK : value;
}

/** Ссылка на вход, после которого сервис вернёт на `returnTo`. */
export const signInHref = (returnTo: string) => `/account?return=${encodeURIComponent(returnTo)}`;
