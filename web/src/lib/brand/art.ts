// Пиксельные размеры вырезок из web/static/art (после tools/art/web_encode.sh). Атрибуты
// width/height у <img> задают пропорцию до загрузки: отложенная загрузка декора (loading="lazy")
// не сдвигает страницу. CSS компонентов всё так же задаёт ширину и высоту; таблицу с файлами
// сверяет tests/art-sizes.test.ts.
export const artSizes: Record<string, readonly [number, number]> = {
  "branding/logo-main-s01": [1600, 419],
  "furniture/armchair": [800, 811],
  "devices/boombox-s02": [520, 368],
  "hardware/paperclip-s02": [110, 250],
  "hardware/binder-clip-s03": [140, 198],
  "mascots/cat-listen-s01": [528, 604],
  "mascots/cat-guitar-s03": [600, 616],
  "mascots/cat-sing-s01": [600, 666],
  "mascots/cat-sing-s02": [800, 730],
  "mascots/cat-paw-up-s01": [584, 548],
  "mascots/cat-encouragement-s03": [556, 636],
  "mascots/cat-sleep-s02": [800, 498],
  "mascots/cat-empty-s03": [888, 568],
  "mascots/cat-laptop-s03": [840, 532],
  "mascots/cat-sleep-s01": [800, 361],
  "stickers/star-red-distressed-s02": [200, 197],
  "stickers/star-spiral-s01": [200, 199],
  "stickers/star-black-s03": [200, 198],
  "stickers/star-cream-outline-s01": [200, 249],
  "cassettes/cassette-black-blank": [340, 212],
  "cassettes/cassette-red-blank": [340, 210],
  "music/headphones-s01": [492, 588],
  "music/compact-disc-s01": [616, 628],
  "doodles/note-pair-s01": [208, 200],
};

/** Раскладка wide (как в CSS: от 1100×521). Вне её декор сцены (`.scene .deco`) скрыт, поэтому
 *  картинку, видимую только в wide, грузим сразу лишь там, а на телефоне — лениво (не скачивается). */
export function wideLayout(): boolean {
  return typeof matchMedia === "function" && matchMedia("(min-width: 1100px) and (min-height: 521px)").matches;
}

/** width и height для <img> по имени файла без .webp; для неизвестного файла — ничего. */
export function artDims(name: string): { width?: number; height?: number } {
  const size = artSizes[name];
  return size ? { width: size[0], height: size[1] } : {};
}

/** Прозрачный GIF 1×1: источник <picture> для картинок, которые на телефоне скрыты (CSP
 *  разрешает data: в img-src). Браузер выбирает его вместо файла и файл не скачивает. */
export const PHONE_BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
