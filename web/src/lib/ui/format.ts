/** Склонение по числу: plural(5, ["попытка", "попытки", "попыток"]). */
export function plural(n: number, [one, few, many]: [string, string, string]) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Число и слово в нужной форме через неразрывный пробел: «32 фрагмента», «21 секунда». */
export const count = (n: number, forms: [string, string, string]) => `${n} ${plural(n, forms)}`;

/** Формы частых слов интерфейса. */
export const FRAGMENTS: [string, string, string] = ["фрагмент", "фрагмента", "фрагментов"];
export const SECONDS: [string, string, string] = ["секунда", "секунды", "секунд"];

/** Короткая длительность без переноса между числом и единицей: «23 сек». */
export const sec = (s: number) => `${Math.round(s)} сек`;

/** Число со знаком и типографским минусом: +3, −5, 0. */
export const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 10) / 10)}`;
