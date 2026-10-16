// Состояние кабинета: профиль текущей серверной сессии и рейтинг.
import { api } from "./http";
import type { Profile, Summary as RatingSummary } from "./types";
import type { AgeGroup } from "#lib/auth/age.ts";

/** Профиль кабинета. У входа через Яндекс ID или VK ID нет почты и пароля. */
export type AccountProfile = Omit<Profile, "email"> & {
  email?: string | null;
  /** false — кабинет без пароля: подтверждение словом «УДАЛИТЬ». Старый сервер поле не присылает. */
  hasPassword?: boolean;
  providers?: string[];
};

export const account = $state<{
  loaded: boolean;
  offline: boolean;
  profile: AccountProfile | null;
  rating: RatingSummary | null;
}>({ loaded: false, offline: false, profile: null, rating: null });

export async function refreshAccount() {
  try {
    const me = await api<{ profile: AccountProfile | null; rating?: RatingSummary }>("me");
    account.profile = me.profile;
    account.rating = me.rating ?? null;
    account.offline = false;
  } catch {
    account.offline = true;
  } finally {
    account.loaded = true;
  }
}

export async function login(email: string, password: string) {
  const r = await api<{ profile: AccountProfile }>("login", { method: "POST", body: { email, password } });
  account.profile = r.profile;
  await refreshAccount();
}

export async function register(email: string, name: string, password: string, consent: boolean, ageGroup: AgeGroup, parentName: string | null) {
  const r = await api<{ profile: AccountProfile }>("register", {
    method: "POST",
    body: { email, name, password, consent, ageGroup, parentName },
  });
  account.profile = r.profile;
  await refreshAccount();
}

/** Первый вход через провайдера: кабинет создаётся после согласия и указания возраста. */
export async function completeSignup(token: string, consent: boolean, ageGroup: AgeGroup, parentName: string | null) {
  const r = await api<{ profile: AccountProfile }>("auth/complete", {
    method: "POST",
    body: { token, consent, ageGroup, parentName },
  });
  account.profile = r.profile;
  await refreshAccount();
}

export async function logout() {
  await api("logout", { method: "POST" });
  account.profile = null;
  account.rating = null;
}
