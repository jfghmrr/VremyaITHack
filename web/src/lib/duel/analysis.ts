// Разбор дуэли: сравнение двух участников по осям оценки и общие трудные места.
// Только отображение: баллы и оси считает ядро (на сервере — итог, в браузере — те же кривые).
import type { Axes, Moment, Reason, ScoreResult } from "#lib/scoring/types.ts";

export const AXES: { key: keyof Axes; label: string; weight: number; hint: string }[] = [
  { key: "intervals", label: "Интервалы", weight: 45, hint: "точность шагов мелодии в своей тональности" },
  { key: "rhythm", label: "Ритм", weight: 25, hint: "вовремя ли начинаются ноты" },
  { key: "stability", label: "Устойчивость", weight: 15, hint: "ровность длинных нот" },
  { key: "coverage", label: "Покрытие", weight: 15, hint: "какая часть мелодии спета" },
];

export interface AxisRow {
  key: keyof Axes;
  label: string;
  weight: number;
  hint: string;
  mine: number | null;
  theirs: number | null;
  /** Разница в баллах (ты − соперник), null без данных у одного из участников. */
  diff: number | null;
  /** Кто лучше по оси: «mine», «theirs» или «tie» (разница меньше 2 баллов). */
  better: "mine" | "theirs" | "tie" | null;
}

const pts = (v: number | undefined | null) => (v == null ? null : Math.round(v * 100));

export function compareAxes(mine: Axes | null | undefined, theirs: Axes | null | undefined): AxisRow[] {
  return AXES.map((a) => {
    const m = pts(mine?.[a.key]);
    const t = pts(theirs?.[a.key]);
    const diff = m != null && t != null ? m - t : null;
    const better = diff == null ? null : Math.abs(diff) < 2 ? "tie" : diff > 0 ? "mine" : "theirs";
    return { ...a, mine: m, theirs: t, diff, better };
  });
}

/** Короткий вывод для игрока: где он сильнее и где соперник, по самой большой разнице. */
export function verdict(rows: AxisRow[], rival: string): string {
  const known = rows.filter((r) => r.diff != null);
  if (!known.length) return "Для сравнения по осям нужны полные линии обоих участников.";
  const ahead = known.filter((r) => r.better === "mine").sort((a, b) => b.diff! - a.diff!);
  const behind = known.filter((r) => r.better === "theirs").sort((a, b) => a.diff! - b.diff!);
  const parts: string[] = [];
  if (ahead.length) parts.push(`Ты сильнее: ${ahead.map((r) => `${r.label.toLowerCase()} (+${r.diff})`).join(", ")}.`);
  if (behind.length) parts.push(`${rival} сильнее: ${behind.map((r) => `${r.label.toLowerCase()} (+${-r.diff!})`).join(", ")}.`);
  if (!parts.length) parts.push("По всем осям почти вровень.");
  return parts.join(" ");
}

export const REASON_LABEL: Record<Reason, string> = {
  pitch: "мимо нот",
  rhythm: "не в ритм",
  missing: "часть не спета",
};

export interface DuelMoment {
  start_s: number;
  end_s: number;
  phrase: number;
  /** Потери баллов в этом месте (0..1) у каждого: 0 — место прошло чисто. */
  mine: number;
  theirs: number;
  mineMoment: Moment | null;
  theirsMoment: Moment | null;
}

/**
 * Трудные места дуэли: окна разбора ядра (по 2 с), где суммарно потеряно больше всего.
 * Окна обоих участников совпадают по времени начала: ядро режет фразы одинаково.
 */
export function hardestMoments(mine: ScoreResult | null, theirs: ScoreResult | null, limit = 3): DuelMoment[] {
  const byStart = new Map<number, DuelMoment>();
  const key = (m: Moment) => Math.round(m.start_s * 100);
  for (const [side, result] of [["mine", mine], ["theirs", theirs]] as const) {
    for (const m of result?.moments ?? []) {
      const k = key(m);
      const row = byStart.get(k) ?? { start_s: m.start_s, end_s: m.end_s, phrase: m.phrase, mine: 0, theirs: 0, mineMoment: null, theirsMoment: null };
      row[side] = m.loss;
      if (side === "mine") row.mineMoment = m;
      else row.theirsMoment = m;
      byStart.set(k, row);
    }
  }
  return [...byStart.values()]
    .sort((a, b) => b.mine + b.theirs - (a.mine + a.theirs) || a.start_s - b.start_s)
    .slice(0, limit)
    .sort((a, b) => a.start_s - b.start_s);
}
