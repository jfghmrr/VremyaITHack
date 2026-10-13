import { useEffect, useState } from "react";
import type { ScoreResult } from "../scoring";
export type Profile = { id: string; name: string };
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
const PROFILE = "perepev.profile.v1",
  HISTORY = "perepev.history.v1";
function readProfile(): Profile | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE) || "null");
    return p && typeof p.id === "string" && typeof p.name === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}
function readHistory(): Attempt[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(HISTORY) || "[]");
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
          .slice(0, 50)
      : [];
  } catch {
    return [];
  }
}
export function useProfile() {
  const [profile, setProfile] = useState(readProfile),
    [attempts, setAttempts] = useState(readHistory),
    [storageError, setStorageError] = useState("");
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === PROFILE || event.key === null)
        setProfile(readProfile());
      if (event.key === HISTORY || event.key === null)
        setAttempts(readHistory());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function register(name: string) {
    const p = { id: profile?.id || crypto.randomUUID(), name: name.trim() };
    if (p.name.length < 2 || p.name.length > 32)
      throw new Error("Имя должно содержать от 2 до 32 символов.");
    try {
      localStorage.setItem(PROFILE, JSON.stringify(p));
    } catch {
      throw new Error(
        "Не удалось сохранить профиль. Разреши хранение данных сайта или продолжи без регистрации.",
      );
    }
    setProfile(p);
    return p;
  }
  function logout() {
    try {
      localStorage.removeItem(PROFILE);
      setProfile(null);
    } catch {
      setStorageError("Не удалось выйти из профиля: хранилище недоступно.");
    }
  }
  function save(a: Omit<Attempt, "id" | "at" | "owner">) {
    const next = [
      {
        ...a,
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        owner: profile?.id || "guest",
      },
      ...readHistory(),
    ].slice(0, 50);
    setAttempts(next);
    try {
      localStorage.setItem(HISTORY, JSON.stringify(next));
    } catch {
      setStorageError(
        "Результат доступен в этой вкладке. Историю не удалось сохранить на устройстве.",
      );
    }
  }
  return { profile, attempts, register, logout, save, storageError };
}
