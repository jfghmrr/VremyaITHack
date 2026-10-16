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
