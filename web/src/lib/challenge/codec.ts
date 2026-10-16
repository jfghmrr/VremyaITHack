// Ссылка-вызов #echo=… версии 1 (формат прежней версии сохранён без изменений).
// Curve — каноническая кривая (50 мс, 0.1 полутона) в виде знаковых Int16-дельт с маркером
// паузы; JSON сжимается lz-string и кодируется base64url. Балл из ссылки не доверяется:
// дуэль пересчитывает обе кривые одним ядром.
import LZString from "lz-string";
import type { PitchFrame } from "#lib/scoring/types.ts";

export interface Challenge {
  v: 1;
  songId: string;
  name: string;
  shift: number;
  score: number;
  curve: PitchFrame[];
}

interface WireChallenge {
  v: 1;
  songId: string;
  name: string;
  shift: number;
  score: number;
  curve: string;
}

const NULL = -32768;

export function encodeChallenge(challenge: Challenge): string {
  if (challenge.curve.length > 1200) throw new Error("Слишком длинная попытка. Максимум 60 секунд.");
  const deltas = new Int16Array(challenge.curve.length);
  let previous = 0;
  challenge.curve.forEach((f, i) => {
    if (f.midi === null) {
      deltas[i] = NULL;
      previous = 0;
    } else {
      const value = Math.round(f.midi * 10);
      deltas[i] = value - previous;
      previous = value;
    }
  });
  const wire: WireChallenge = {
    v: 1,
    songId: challenge.songId,
    name: challenge.name.trim().slice(0, 32) || "Соперник",
    shift: Math.round(challenge.shift * 10) / 10,
    score: Math.round(challenge.score * 10) / 10,
    curve: Array.from(deltas, (v) => String.fromCharCode(v & 65535)).join(""),
  };
  const bytes = LZString.compressToUint8Array(JSON.stringify(wire));
  const hash = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (hash.length > 8000) throw new Error("Ссылка получилась слишком длинной. Выбери короткий фрагмент.");
  return `#echo=${hash}`;
}

export function decodeChallenge(hash: string): Challenge | null {
  if (!hash) return null;
  if (!hash.startsWith("#echo=") || hash.length > 8006 || !/^[-_A-Za-z0-9]+$/.test(hash.slice(6)))
    throw new Error("Некорректная ссылка-вызов. Попроси друга отправить её ещё раз.");
  try {
    const encoded = hash.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(encoded);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (bytes.length % 2) throw Error();
    const json = LZString.decompressFromUint8Array(bytes);
    if (!json || json.length > 20000) throw Error();
    const wire: unknown = JSON.parse(json);
    if (!wire || typeof wire !== "object") throw Error();
    const w = wire as WireChallenge;
    if (
      w.v !== 1 ||
      typeof w.songId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,48}$/.test(w.songId) ||
      typeof w.name !== "string" ||
      w.name.length > 32 ||
      !Number.isFinite(w.shift) ||
      Math.abs(w.shift) > 60 ||
      !Number.isFinite(w.score) ||
      w.score < 0 ||
      w.score > 100 ||
      typeof w.curve !== "string" ||
      w.curve.length < 2 ||
      w.curve.length > 1200
    )
      throw Error();
    let previous = 0;
    const curve: PitchFrame[] = [];
    for (let i = 0; i < w.curve.length; i++) {
      const unsigned = w.curve.charCodeAt(i);
      const delta = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      if (delta === NULL) {
        previous = 0;
        curve.push({ t: i * 0.05, midi: null });
        continue;
      }
      const q = previous + delta;
      if (q < 0 || q > 1270) throw Error();
      previous = q;
      curve.push({ t: i * 0.05, midi: q / 10 });
    }
    return { ...w, curve };
  } catch {
    throw new Error("Вызов повреждён или создан несовместимой версией. Попроси друга отправить новый.");
  }
}
