import { useEffect, useRef, useState } from "react";
import type { ScoreResult } from "../scoring";
export type Profile = { id: string; name: string; email: string };
export type Attempt = {
  id: string;
  owner: string;
  name: string;
  songId: string;
  title: string;
  at: string;
  score: number;
  axes: ScoreResult["axes"];
  shift: number;
  moments: ScoreResult["moments"];
};
export type Credentials = {
  name: string;
  email: string;
  password: string;
  consent: boolean;
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Perepev-Request": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(
      "Нет связи с кабинетом. Проверь соединение и попробуй снова. Петь можно без входа.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер кабинета недоступен. Петь можно без входа.");
  }
  if (!response.ok)
    throw new Error(data.error || "Не удалось выполнить запрос.");
  return data as T;
}
function readHistory(): Attempt[] {
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem("perepev.history.v1") || "[]",
    );
    return Array.isArray(data)
      ? data
          .filter(
            (a): a is Attempt =>
              a &&
              typeof a.id === "string" &&
              typeof a.owner === "string" &&
              typeof a.name === "string" &&
              typeof a.songId === "string" &&
              typeof a.title === "string" &&
              typeof a.at === "string" &&
              Number.isFinite(a.score) &&
              a.axes &&
              ["intervals", "rhythm", "stability", "coverage"].every((k) =>
                Number.isFinite(a.axes[k]),
              ) &&
              Array.isArray(a.moments) &&
              a.moments.every(
                (m: unknown) =>
                  !!m &&
                  typeof m === "object" &&
                  "text" in m &&
                  typeof m.text === "string",
              ),
          )
          .filter((a) => a.owner === "guest")
          .slice(0, 50)
      : [];
  } catch {
    return [];
  }
}
export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>(readHistory);
  const [storageError, setStorageError] = useState("");
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const [pendingSave, setPendingSave] = useState<Attempt | null>(null);
  const [saving, setSaving] = useState(false);
  async function refresh() {
    const id = ++revision.current;
    try {
      const data = await api<{ profile: Profile | null }>("me");
      const history = data.profile
        ? (await api<{ attempts: Attempt[] }>("attempts")).attempts
        : readHistory();
      if (id !== revision.current) return;
      setProfile(data.profile);
      setAttempts(history);
      setStorageError("");
    } catch (e) {
      if (id === revision.current) setStorageError((e as Error).message);
    } finally {
      if (id === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const sync = () => void refresh();
    window.addEventListener("focus", sync);
    return () => {
      revision.current++;
      window.removeEventListener("focus", sync);
    };
  }, []);
  async function authenticate(mode: "register" | "login", value: Credentials) {
    const { profile: p } = await api<{ profile: Profile }>(mode, "POST", value);
    ++revision.current;
    setProfile(p);
    setAttempts([]);
    setStorageError("");
    setLoading(false);
    try {
      setAttempts((await api<{ attempts: Attempt[] }>("attempts")).attempts);
    } catch (e) {
      setStorageError((e as Error).message);
    }
    return p;
  }
  async function logout() {
    await api("logout", "POST", {});
    ++revision.current;
    setProfile(null);
    setPendingSave(null);
    setAttempts(readHistory());
    setStorageError("");
  }
  async function updateName(name: string) {
    const { profile: p } = await api<{ profile: Profile }>("me", "PATCH", {
      name,
    });
    setProfile(p);
  }
  async function changePassword(currentPassword: string, newPassword: string) {
    await api("password", "POST", { currentPassword, newPassword });
  }
  async function save(a: Omit<Attempt, "id" | "at" | "owner">) {
    const attempt = {
      ...a,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      owner: profile?.id || "guest",
    };
    if (!profile) {
      const next = [attempt, ...readHistory()].slice(0, 50);
      setAttempts(next);
      try {
        localStorage.setItem("perepev.history.v1", JSON.stringify(next));
      } catch {
        setStorageError(
          "Результат остался во вкладке. История на устройстве недоступна.",
        );
      }
      return;
    }
    await persist(attempt);
  }
  async function persist(attempt: Attempt) {
    if (attempt.owner !== profile?.id) {
      setStorageError(
        "Войди в исходный кабинет, чтобы сохранить этот результат.",
      );
      return;
    }
    setSaving(true);
    try {
      await api("attempts", "POST", attempt);
      setAttempts((items) =>
        [attempt, ...items.filter((item) => item.id !== attempt.id)].slice(
          0,
          100,
        ),
      );
      setPendingSave(null);
      setStorageError("");
    } catch (e) {
      setPendingSave(attempt);
      setStorageError(
        `Результат не сохранён в кабинете: ${(e as Error).message} Можно повторить сохранение до закрытия вкладки.`,
      );
    } finally {
      setSaving(false);
    }
  }
  async function retrySave() {
    if (pendingSave && !saving) await persist(pendingSave);
  }
  return {
    profile,
    pendingSave,
    saving,
    retrySave,
    attempts,
    storageError,
    loading,
    authenticate,
    logout,
    updateName,
    changePassword,
    save,
    refresh,
  };
}
