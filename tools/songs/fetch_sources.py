#!/usr/bin/env python3
"""Скачивает MIDI-источники каталога с Wikimedia Commons и проверяет их лицензию.

Принимаются только файлы с CC0 или Public domain. Результат: cache/<id>.mid и
sources.json (адрес, лицензия, автор записи) — основа для LICENSES.md.
"""
import json, time, urllib.parse, urllib.request
from pathlib import Path
from catalog import SONGS

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
UA = {"User-Agent": "PerepevSongCatalog/1.0 (osipovsemen2008@gmail.com)"}
ALLOWED = {"CC0", "Public domain", "PD", "Public Domain"}

def api(params):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(6):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(20 * (attempt + 1))
    raise RuntimeError("rate limited")

sources = {}
for song in SONGS:
    title = song["source"]
    if title is None:
        continue
    info = api({"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url|extmetadata"})
    page = next(iter(info["query"]["pages"].values()))
    ii = page["imageinfo"][0]
    meta = ii["extmetadata"]
    lic = meta.get("LicenseShortName", {}).get("value", "")
    if lic not in ALLOWED:
        print(f"ПРОПУСК {song['id']}: {title} — лицензия {lic!r}")
        continue
    target = CACHE / f"{song['id']}.mid"
    if not target.exists():
        data = urllib.request.urlopen(urllib.request.Request(ii["url"].split("?")[0], headers=UA), timeout=60).read()
        target.write_bytes(data)
        time.sleep(1.5)
    artist = urllib.parse.unquote(meta.get("Artist", {}).get("value", ""))
    import re
    sources[song["id"]] = {
        "file": title,
        "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
        "license": lic,
        "author": re.sub(r"<[^>]+>", "", artist).strip(),
    }
    print(f"{song['id']:<14} {lic:<14} {title}")
    time.sleep(1.5)
(HERE / "sources.json").write_text(json.dumps(sources, ensure_ascii=False, indent=2) + "\n")
