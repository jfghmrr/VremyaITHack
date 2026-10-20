// Лестница рангов по MMR для подсказки на странице дуэлей. Пороги те же, что в
// crates/api/src/ratings.rs (fn rank); совпадение проверяет tests/ranks.test.ts.
// Ранг игрока по-прежнему присылает сервер (account.rating.rank) — здесь только подписи.
export type Rank = { name: string; from: number | null };

/** Сколько рейтинговых дуэлей длится калибровка по умолчанию — `calibration_matches` в
 *  crates/api/src/config.rs (сверяет tests/ranks.test.ts). Сервер может переопределить его файлом
 *  GAME_CONFIG: вошедший игрок видит своё значение из /api/me (`rating.calibrationTotal`), а гостю
 *  взять его неоткуда — он видит это значение по умолчанию. */
export const CALIBRATION_DEFAULT = 10;

export const RANKS: readonly Rank[] = [
  { name: "Новичок", from: null },
  { name: "Любитель", from: 1000 },
  { name: "Исполнитель", from: 1200 },
  { name: "Вокалист", from: 1400 },
  { name: "Виртуоз", from: 1600 },
];

/** Подпись диапазона: «до 1000» для первой ступени, «от 1200» для остальных. */
export function rankRange(i: number): string {
  const from = RANKS[i]?.from;
  return from === null || from === undefined ? `до ${RANKS[1].from}` : `от ${from}`;
}
