#!/usr/bin/env bash
# Web re-encode of the site art (performance audit R2, 17.10.2026): every file keeps its name and
# aspect ratio and is resized to what the largest measured display needs (phone @3x, laptop @2x,
# Full HD @1x), then saved as lossy WebP. Lossy, so run it ONCE on fresh files (for example right
# after tools/art/restore_assets.py), never twice on the same files, and bump the ?v= art version
# in web/src/lib/brand/*.svelte afterwards. Needs ImageMagick 7 (magick) and libwebp (cwebp).
# usage: tools/art/web_encode.sh [art-dir]   (default: web/static/art)
set -euo pipefail
ART=${1:-"$(cd "$(dirname "$0")/../.." && pwd)/web/static/art"}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# enc <name without .webp> <width or "same"> <quality>
enc() {
  local f="$ART/$1.webp" png="$TMP/frame.png" out="$TMP/out.webp"
  if [ "$2" = same ]; then magick "$f" "$png"; else magick "$f" -resize "${2}x>" "$png"; fi
  cwebp -quiet -q "$3" -alpha_q 90 -m 6 -sharp_yuv "$png" -o "$out"
  mv "$out" "$f"
}
enc furniture/armchair 800 82
enc branding/logo-main-s01 1600 82
enc backgrounds/home-no-lamp same 75
for b in 02-song-selection 03-microphone-check 04-performance 05-result 06-duel 07-leaderboard 09-empty-state; do
  enc "backgrounds/$b" same 75
done
enc mascots/cat-sing-s01 600 82
enc mascots/cat-guitar-s03 600 82
enc mascots/cat-sing-s02 800 82
enc mascots/cat-sleep-s01 800 82
enc mascots/cat-sleep-s02 800 82
for c in cat-listen-s01 cat-paw-up-s01 cat-encouragement-s03 cat-laptop-s03 cat-empty-s03; do
  enc "mascots/$c" same 82
done
enc devices/boombox-s02 same 82
for s in star-red-distressed-s02 star-black-s03 star-spiral-s01 star-cream-outline-s01; do
  enc "stickers/$s" 200 82
done
# cassettes/cassette-{black,red}-blank.webp are already web-sized (340 px, made from the removed
# cassette-{black,red}-s01 with the band names on the label painted out): not re-encoded here.
enc hardware/binder-clip-s03 140 82
enc hardware/paperclip-s02 110 82
echo "re-encoded art in $ART"
