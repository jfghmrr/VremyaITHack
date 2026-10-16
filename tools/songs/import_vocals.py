#!/usr/bin/env python3
"""Package reviewed vocal excerpts. Inputs remain local; no network or ML downloads.

python import_vocals.py --jobs 2
Requires cache/vocals/<id>.mp3 and cache/analysis/<id>/{vocal.wav,transcript.json}.
The aligned stem is used only to measure pitch; the player hears the original mix.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
from difflib import SequenceMatcher
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg
import librosa
import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "web/static/songs"
SR = 16000


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def key(text):
    return re.sub(r"[^\w]", "", text.lower().replace("ё", "е"))


def word_timing(track, transcript):
    """Align edited words to ASR anchors; interpolate only unmatched corrections.

    ASR boundaries are hints, not authoritative text. The manifest is authoritative.
    Zero-length ASR tokens and hallucinations cannot reach the published sidecar.
    """
    source = [w for s in transcript["segments"] for w in s["words"] if w["end"] > w["start"]]
    result = []
    shift = track["clip"]["lead_s"] - track["clip"]["start_s"]
    for i, line in enumerate(track["lines"]):
        words = line["text"].split()
        start, end = line["start_s"], line["end_s"]
        candidates = [w for w in source if start <= (w["start"] + w["end"]) / 2 < end]
        anchors = {}
        matcher = SequenceMatcher(None, [key(w) for w in words], [key(w["word"]) for w in candidates], autojunk=False)
        for a, b, length in matcher.get_matching_blocks():
            for k in range(length):
                anchors[a + k] = candidates[b + k]
        boundaries = np.linspace(start, end, len(words) + 1)
        known = {0: start, len(words): end}
        for j, w in anchors.items():
            if 0 < j < len(words):
                known[j] = max(start, min(end, w["start"]))
        xs = sorted(known)
        boundaries = np.interp(np.arange(len(words) + 1), xs, [known[x] for x in xs])
        # Keep boundaries strictly increasing even for coalesced ASR words.
        for j in range(1, len(boundaries) - 1):
            boundaries[j] = min(end - .012 * (len(words) - j), max(boundaries[j - 1] + .012, boundaries[j]))
        timed = []
        for j, text in enumerate(words):
            finish = boundaries[j + 1]
            if j in anchors:
                finish = max(boundaries[j] + .01, min(finish, anchors[j]["end"]))
            timed.append({"text": text, "start_s": round(boundaries[j] + shift, 4), "end_s": round(finish + shift, 4)})
        result.append({"line": i, "words": timed})
    return {"v": 1, "lines": result}


def package(track):
    ident = track["id"]
    assert re.fullmatch(r"[a-z0-9-]{1,48}", ident), ident
    source = HERE / "cache/vocals" / (ident + ".mp3")
    analysis = HERE / "cache/analysis" / ident
    assert digest(source) == track["sourceSha256"], f"Source changed: {ident}"
    start, end, lead = (track["clip"][k] for k in ("start_s", "end_s", "lead_s"))
    duration = round(end - start + lead, 2)
    assert 0 < duration <= 60 and start >= 0
    previous = start
    for line in track["lines"]:
        assert previous <= line["start_s"] < line["end_s"] <= end, (ident, line)
        previous = line["end_s"]
    dest = OUT / ident
    dest.mkdir(parents=True, exist_ok=True)
    # Re-encode decoded PCM so source timestamps/cover art cannot corrupt the crop.
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    raw = subprocess.check_output([ffmpeg, "-v", "error", "-ss", str(start), "-i", str(source),
                                   "-t", str(end-start), "-map", "0:a:0", "-vn", "-ar", "44100", "-ac", "2", "-f", "f32le", "-"])
    mix = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()
    expected = round((end-start) * 44100)
    assert abs(len(mix)-expected) <= 1, f"Incomplete source: {ident}"
    for count, fade in ((1323, np.linspace(0, 1, 1323)), (-3528, np.linspace(1, 0, 3528))):
        if count > 0:
            mix[:count] *= fade[:, None]
        else:
            mix[count:] *= fade[:, None]
    mix = np.pad(mix, ((round(lead*44100), 0), (0, 0)))
    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "f32le", "-ar", "44100", "-ac", "2", "-i", "-",
                    "-codec:a", "libmp3lame", "-b:a", "160k", str(dest / "backing.mp3")], input=mix.tobytes(), check=True)
    signal, original_sr = sf.read(analysis / "vocal.wav", always_2d=True)
    signal = signal[round(start * original_sr):round(end * original_sr)].mean(axis=1)
    signal = librosa.resample(signal, orig_sr=original_sr, target_sr=SR)
    signal = np.pad(signal, (round(lead * SR), max(0, round((end-start)*SR) - len(signal))))
    n = round(duration * 100)
    # Cache only the expensive pitch measurement, keyed by both stem and crop.
    pitch_key = hashlib.sha256((digest(analysis / "vocal.wav") + str(track["clip"]) + "pyin-v1").encode()).hexdigest()[:16]
    cache = analysis / ("pitch-" + pitch_key + ".npy")
    if cache.exists():
        midi = np.load(cache)
    else:
        f0, voiced, probability = librosa.pyin(signal, sr=SR, fmin=65, fmax=1100, frame_length=1024, hop_length=160)
        rms = librosa.feature.rms(y=signal, frame_length=1024, hop_length=160)[0]
        midi = librosa.hz_to_midi(f0)
        midi[~voiced | (probability < .1) | (rms < .003)] = np.nan
        # Three-frame median removes isolated pitch glitches without quantising singing.
        smooth = median_filter(np.nan_to_num(midi, nan=0), size=3)
        midi = np.where(smooth > 0, smooth, np.nan)
        np.save(cache, midi)
    midi = np.pad(midi[:n], (0, max(0, n-len(midi))), constant_values=np.nan)
    # Ignore stem bleed outside the selected lyrical lines.
    allowed = np.zeros(n, dtype=bool)
    for line in track["lines"]:
        a = max(0, math.floor((line["start_s"] - start + lead - .08) * 100))
        b = min(n, math.ceil((line["end_s"] - start + lead + .08) * 100))
        allowed[a:b] = True
    midi[~allowed] = np.nan
    curve = [round(float(x), 3) if np.isfinite(x) else None for x in midi]
    assert sum(x is not None for x in curve) > n * .1, f"No usable vocal pitch: {ident}"
    timing = word_timing(track, json.loads((analysis / "transcript.json").read_text()))
    song = {k: track[k] for k in ("id", "title", "artist")}
    song.update(hop_ms=10, duration_s=duration, f0_midi=curve, backing="backing.mp3",
                phrases=[{"start_s": round(l["start_s"]-start+lead, 4), "end_s": round(l["end_s"]-start+lead, 4)} for l in track["lines"]],
                lyrics=[{"t": l["words"][0]["start_s"], "text": " ".join(w["text"] for w in l["words"])} for l in timing["lines"]])
    write_json(dest / "reference.json", song)
    write_json(dest / "lyrics.words.json", timing)
    credit = {k: track[k] for k in ("id", "title", "artist", "credits", "language", "source", "license", "licenseUrl", "lyricsSource", "clip", "reviewedAt", "sourceSha256")}
    credit["preparation"] = {"by": "mugsize", "changes": "Короткий фрагмент, подготовительная пауза, плавные границы; эталон высоты и разметка слов.", "pitch": "librosa pYIN, 16 kHz / 10 ms; " + track["method"], "wordTiming": track["timingNote"], "adaptationLicense": track["license"], "stemOffset_s": json.loads((analysis / "transcript.json").read_text()).get("stemOffset_s", 0)}
    credit["files"] = {name: digest(dest / name) for name in ("backing.mp3", "reference.json", "lyrics.words.json")}
    write_json(dest / "CREDITS.json", credit)
    info = {k: track[k] for k in ("id", "title", "artist", "language", "license")}
    info.update(duration_s=duration, tag="С вокалом", category="Русские" if track["language"] == "ru" else "English", hasVocals=True, preview="backing.mp3", wordTiming="lyrics.words.json", credits="CREDITS.json", contour=curve[::max(1, n//80)])
    print(f"{ident}: {duration:.2f}s, voiced {sum(x is not None for x in curve)/n:.0%}", flush=True)
    return info, credit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    tracks = json.loads((HERE / "vocal_catalog.json").read_text())
    assert len({t["id"] for t in tracks}) == len(tracks)
    with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        prepared = list(pool.map(package, tracks))
    # Publish indexes only after every file has been generated and validated.
    # Songs added by `perepev_worker.catalog import` (they carry an age label) are kept as they are.
    legal_path = ROOT / "web/src/lib/legal/vocal-music.json"
    packaged = {info["id"] for info, _ in prepared}
    imported = [e for e in json.loads((OUT / "index.json").read_text()) if e.get("age") and e["id"] not in packaged]
    old_legal = {e["id"]: e for e in json.loads(legal_path.read_text())}
    write_json(OUT / "index.json", [info for info, _ in prepared] + imported)
    write_json(legal_path, [{**{k: c[k] for k in ("id", "title", "artist", "language", "credits", "source", "license", "licenseUrl")},
                             "changes": c["preparation"]["changes"]} for _, c in prepared] + [old_legal[e["id"]] for e in imported])
    print(f"Packaged {len(prepared)} vocal songs.", flush=True)


if __name__ == "__main__":
    main()
