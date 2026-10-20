#!/bin/sh
# Подмножества шрифтов OFL (google/fonts) для сайта: латиница, кириллица и типографские знаки, woff2.
# Нужен fonttools с brotli: pip install fonttools brotli. Запуск из корня репозитория.
set -e
cd web/static/fonts
U="U+0020-007E,U+00A0-00BB,U+00D7,U+0401,U+0410-044F,U+0451,U+2010-2014,U+2018-201E,U+2026,U+2116,U+2190-2193,U+2212,U+2665,U+2713,U+25A0,U+25B6"
for f in Caveat IBMPlexMono-Medium Oswald PTSerif-Bold RubikMonoOne; do
  pyftsubset "$f.ttf" --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file="$f.woff2"
  rm "$f.ttf"
done
# Golos Text (ofl/golostext/GolosText[wght].ttf, сохранённый как GolosText.ttf) — основной шрифт
# интерфейса: шире набор (латиница до U+017F, кириллица с украинскими и белорусскими буквами,
# пунктуация, стрелки, геометрические знаки), ось wght 400–900 и все записи name сохраняются.
# Знаки сайта, каталога и ответов API проверяет web/tests/e2e/font.spec.ts.
G="U+0000-017F,U+0400-045F,U+0490-0491,U+2010-203A,U+20AC,U+20BD,U+2116,U+2122,U+2190-2199,U+2212,U+2264-2265,U+25A0-25FF,U+2661,U+266A,U+2713,U+FEFF,U+FFFD"
pyftsubset GolosText.ttf --unicodes="$G" --layout-features='*' --name-IDs='*' --flavor=woff2 --output-file=GolosText.woff2
rm GolosText.ttf
