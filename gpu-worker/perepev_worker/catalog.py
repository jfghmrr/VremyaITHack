"""Catalog tools.

    python -m perepev_worker.catalog stems <songs_dir> [--ids ID ...] [--force]

Writes `instrumental.mp3` and `guide.mp3` (separated vocal) next to each indexed song's
`backing.mp3`, records them in its CREDITS.json and sets `"stems": true` in index.json.
Only songs listed in index.json are touched; reference.json is never changed.

    python -m perepev_worker.catalog import <audio> --id ID --clip A,B --lyrics lyrics.txt \
        --language ru|en --credits credits.json --age 0+|6+ [--title T] [--artist A] \
        [--lead 1.0] [--songs-dir web/static/songs] [--force]

Builds a karaoke song from a free recording and its known (public-domain) lyrics: the
section [A, B] seconds of the recording (complete sung lines) plus `--lead` seconds of
silence becomes backing.mp3, Demucs gives instrumental.mp3 and guide.mp3, torchcrepe the
reference melody, whisper the timing of the known lyric words (see align.py). The lyric
text in reference.json and lyrics.words.json is the known lyrics, one line per text line.
CREDITS.json is the given credits plus the clip, the preparation and SHA-256 of every file;
the index entry gets `"stems": true`, `"hasVocals": true`, the language and the age label.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import re
import time
from datetime import date
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import load_audio, mp3_bytes, rms, write_mp3

SR = 44100
STEMS = ("instrumental.mp3", "guide.mp3")
STEMS_NOTE = ("Минус и голос-подсказка для караоке: backing.mp3 разделён моделью htdemucs "
              "(Demucs 4, MIT), MP3 160 кбит/с; время совпадает с backing.mp3.")


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data) -> None:
    # Same compact style as tools/songs/import_vocals.py.
    path.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n", encoding="utf-8")


def _record_credits(song_dir: Path) -> None:
    path = song_dir / "CREDITS.json"
    if not path.exists():
        return
    credits = _read_json(path)
    credits.setdefault("preparation", {})["stems"] = STEMS_NOTE
    files = credits.setdefault("files", {})
    for name in STEMS:
        files[name] = hashlib.sha256((song_dir / name).read_bytes()).hexdigest()
    _write_json(path, credits)


def has_stems(song_dir: Path) -> bool:
    return all((song_dir / name).exists() for name in STEMS)


def run_stems(songs_dir: str | Path, ids: list[str] | None = None, separator=None, force: bool = False) -> list[str]:
    """Separate the indexed songs (all, or `ids`); returns the ids that were processed."""
    songs_dir = Path(songs_dir)
    index_path = songs_dir / "index.json"
    index = _read_json(index_path)
    known = [entry["id"] for entry in index]
    wanted = ids or known
    unknown = sorted(set(wanted) - set(known))
    if unknown:
        raise SystemExit(f"not in index.json (left untouched): {', '.join(unknown)}")
    if separator is None:
        from .separate import separate as separator
    done = []
    for song_id in wanted:
        song_dir = songs_dir / song_id
        if has_stems(song_dir) and not force:
            print(f"{song_id}: stems exist, skipped", flush=True)
            continue
        started = time.monotonic()
        mix = load_audio(song_dir / "backing.mp3", SR, mono=False)
        vocals, instrumental = separator(mix, SR)
        write_mp3(song_dir / "instrumental.mp3", instrumental, SR)
        write_mp3(song_dir / "guide.mp3", vocals, SR)
        _record_credits(song_dir)
        done.append(song_id)
        print(f"{song_id}: {len(mix) / SR:.2f} s separated in {time.monotonic() - started:.1f} s", flush=True)
    for entry in index:
        if has_stems(songs_dir / entry["id"]):
            entry["stems"] = True
    _write_json(index_path, index)
    return done


# --- catalog import -------------------------------------------------------------------

ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# The site and the API read "my-<track>" as a user's own track (web/src/lib/catalog.ts, crates/api/src/perf.rs).
OWN_TRACK_PREFIX = "my-"
AGES = ("0+", "6+")
CATEGORY = {"ru": "Русские", "en": "English"}
MIN_CLIP_S, MAX_CLIP_S = 15.0, 60.0
SEPARATION_MARGIN_S = 2.0
# The reference melody is kept only around the lyric lines: instruments leaking into the
# separated vocal between lines would otherwise become melody nobody sings.
LINE_MARGIN_S = 0.25
CONTOUR_POINTS = 80
REQUIRED_CREDITS = ("title", "artist", "credits", "source", "download", "license", "licenseUrl",
                    "lyricsSource", "review")


def parse_clip(text: str) -> tuple[float, float]:
    try:
        a, b = (float(x) for x in text.split(","))
    except ValueError as err:
        raise ValueError(f"--clip must be A,B in seconds, got {text!r}") from err
    if not (0 <= a < b):
        raise ValueError(f"--clip needs 0 <= A < B, got {text!r}")
    return a, b


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(data) -> bytes:
    return (json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()


def mask_outside_lines(frames, lines, margin_s: float = LINE_MARGIN_S):
    windows = [(line[0].start_s - margin_s, line[-1].end_s + margin_s) for line in lines if line]
    return [(t, m if any(a <= t <= b for a, b in windows) else None) for t, m in frames]


VOICE_BAND_HZ = (200.0, 4000.0)


def _db(a: float, b: float) -> float:
    return round(20 * math.log10(max(a, 1e-9) / max(b, 1e-9)), 1)


def clip_quality(frames, lines, guide: np.ndarray, instrumental: np.ndarray, sr: int, duration_s: float) -> dict:
    """Listen-check substitute: numbers that show the melody and the guide vocal sit on the lyrics.

    The guide/instrumental level is given for the full band and for the voice band
    (200-4000 Hz), where bass and kick drum do not mask a clearly audible lead vocal.
    """
    from scipy.signal import butter, sosfiltfilt

    windows = [(line[0].start_s, line[-1].end_s) for line in lines if line]
    inside = [m for t, m in frames if any(a <= t < b for a, b in windows)]
    voiced = sum(m is not None for m in inside) / len(inside) if inside else 0.0
    take = lambda y: np.concatenate([y[int(a * sr):int(b * sr)] for a, b in windows]) if windows else y[:0]
    g, i = rms(take(guide)), rms(take(instrumental))
    band = butter(4, VOICE_BAND_HZ, btype="bandpass", fs=sr, output="sos")
    gb, ib = rms(take(sosfiltfilt(band, guide))), rms(take(sosfiltfilt(band, instrumental)))
    words = [w for line in lines for w in line]
    ordered = all(a.end_s <= b.start_s for a, b in zip(words, words[1:]))
    inside_clip = all(0 <= w.start_s < w.end_s <= duration_s for w in words)
    return {
        "voicedInLines": round(voiced, 3),
        "guideOverInstrumentalDb": _db(g, i),
        "guideOverInstrumentalVoiceBandDb": _db(gb, ib),
        "wordsMonotonic": ordered,
        "wordsInsideClip": inside_clip,
    }


def run_import(audio: str | Path, song_id: str, clip: tuple[float, float], lyrics_text: str, language: str,
               credits: dict, songs_dir: str | Path, *, title: str | None = None, artist: str | None = None,
               age: str, lead_s: float = 1.0, force: bool = False, prompt: bool = True,
               separator: Callable | None = None, f0: Callable | None = None, transcriber: Callable | None = None,
               today: str | None = None) -> dict:
    """Build one karaoke song from a recording and its known lyrics; returns the quality report."""
    from .align import align_known, parse_lyrics
    from .profanity import mask
    from .track import _fade, _gate_quiet, build_reference, build_word_timing, clean_words

    songs_dir = Path(songs_dir)
    audio = Path(audio)
    if not ID_RE.match(song_id):
        raise ValueError(f"bad song id {song_id!r}: lower-case latin letters, digits and dashes")
    if song_id.startswith(OWN_TRACK_PREFIX):
        raise ValueError(f"bad song id {song_id!r}: '{OWN_TRACK_PREFIX}' is reserved for users' own tracks")
    if language not in CATEGORY:
        raise ValueError("--language must be ru or en")
    if age not in AGES:
        raise ValueError(f"--age must be one of {', '.join(AGES)}")
    missing = [k for k in REQUIRED_CREDITS if not credits.get(k)]
    if missing and not (title and artist and set(missing) <= {"title", "artist"}):
        raise ValueError(f"credits.json misses {', '.join(missing)}")
    title, artist = title or credits["title"], artist or credits["artist"]
    lines_text = parse_lyrics(lyrics_text)
    if len(lines_text) < 2:
        raise ValueError("lyrics need at least two lines")
    masked = sum(mask(word)[1] for line in lines_text for word in line)
    if masked:
        raise ValueError(f"lyrics contain {masked} obscene word(s); not importable")

    index_path = songs_dir / "index.json"
    index = _read_json(index_path)
    dest = songs_dir / song_id
    if not force and (dest.exists() or any(e["id"] == song_id for e in index)):
        raise ValueError(f"{song_id} already exists (folder or index entry); use --force to replace an imported song")

    a, b = clip
    lead_s = round(lead_s, 2)
    duration_s = round(b - a + lead_s, 2)
    if not (MIN_CLIP_S <= duration_s <= MAX_CLIP_S):
        raise ValueError(f"clip with lead is {duration_s:.2f} s; it must be {MIN_CLIP_S:.0f}-{MAX_CLIP_S:.0f} s")

    source_bytes = audio.read_bytes()
    mix = load_audio(audio, SR, mono=False)
    if b * SR > len(mix) + 1:
        raise ValueError(f"clip end {b} s is past the recording ({len(mix) / SR:.2f} s)")
    s0 = max(0, int(round((a - SEPARATION_MARGIN_S) * SR)))
    s1 = min(len(mix), int(round((b + SEPARATION_MARGIN_S) * SR)))
    started = time.monotonic()
    if separator is None:
        from . import separate as _separate

        vocals, instrumental = _separate.separate(mix[s0:s1], SR)
        _separate._model = None  # one song per process: free Demucs before melody and ASR
        gc.collect()
    else:
        vocals, instrumental = separator(mix[s0:s1], SR)
    ia, ib = int(round(a * SR)) - s0, int(round(a * SR)) - s0 + int(round((b - a) * SR))
    lead = np.zeros((int(round(lead_s * SR)), mix.shape[1]), dtype=np.float32)
    n = int(round(duration_s * SR))

    def cut(x):
        y = np.concatenate([lead, _fade(x[ia:ib], SR)])[:n]
        return np.pad(y, [(0, n - len(y)), (0, 0)]) if len(y) < n else y

    mix_c, vocals_c, inst_c = cut(mix[s0:s1]), cut(vocals), cut(instrumental)
    vocal_mono, inst_mono = vocals_c.mean(axis=1), inst_c.mean(axis=1)

    if f0 is None:
        from .pitch import f0_frames as f0
    frames = _gate_quiet(f0(vocal_mono, SR), vocal_mono, SR)
    if transcriber is None:
        from .words import transcribe as transcriber
    hint = " ".join(" ".join(line) for line in lines_text) if prompt else None
    recognised = clean_words(transcriber(vocal_mono, SR, language, beam_size=5, prompt=hint), duration_s)
    alignment = align_known(lines_text, recognised, start_s=lead_s, end_s=duration_s)
    lines = alignment.lines
    frames = mask_outside_lines(frames, lines)
    quality = clip_quality(frames, lines, vocal_mono, inst_mono, SR, duration_s)
    quality.update(wordsMatched=alignment.matched, wordsTotal=alignment.total, recognisedWords=len(recognised))

    reference = build_reference(song_id, title, duration_s, frames, lines, artist=artist)
    files = {
        "backing.mp3": mp3_bytes(mix_c, SR),
        "instrumental.mp3": mp3_bytes(inst_c, SR),
        "guide.mp3": mp3_bytes(vocals_c, SR),
        "reference.json": _json_bytes(reference),
        "lyrics.words.json": _json_bytes(build_word_timing(lines)),
    }
    from .pitch import MODEL as PITCH_MODEL
    from .separate import MODEL_NAME
    from .words import asr_model_name

    record = {k: v for k, v in credits.items() if k not in ("id", "title", "artist", "language", "clip", "files", "sourceSha256")}
    record = {"id": song_id, "title": title, "artist": artist, **record, "language": language, "age": age,
              "clip": {"start_s": round(a, 2), "end_s": round(b, 2), "lead_s": lead_s},
              "reviewedAt": credits.get("reviewedAt") or today or date.today().isoformat(),
              "sourceSha256": _sha(source_bytes)}
    record["preparation"] = {
        "by": "mugsize",
        "changes": (f"Фрагмент {a:.2f}–{b:.2f} с записи, {lead_s:g} с тишины перед ним, плавные границы; "
                    "голос и минус разделены моделью; эталон высоты по выделенному голосу; "
                    "слова — известный текст песни с пословным временем по записи."),
        "separation": f"{MODEL_NAME} (Demucs 4, MIT), CPU; MP3 160 кбит/с; время совпадает с backing.mp3",
        "pitch": f"torchcrepe {PITCH_MODEL} (MIT), 16 кГц / 10 мс; только около строк текста",
        "wordTiming": (f"Текст из источника lyricsSource; время слов — openai-whisper {asr_model_name()} "
                       "(MIT) по выделенному голосу, несопоставленные слова интерполированы"),
        "adaptationLicense": credits.get("adaptationLicense") or credits["license"],
        "quality": quality,
    }
    record["files"] = {name: _sha(data) for name, data in files.items()}

    dest.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (dest / name).write_bytes(data)
    _write_json(dest / "CREDITS.json", record)

    curve = reference["f0_midi"]
    entry = {"id": song_id, "title": title, "artist": artist, "language": language, "license": credits["license"],
             "duration_s": duration_s, "tag": "С вокалом", "category": CATEGORY[language], "hasVocals": True,
             "preview": "backing.mp3", "wordTiming": "lyrics.words.json", "credits": "CREDITS.json",
             "contour": curve[::max(1, len(curve) // CONTOUR_POINTS)], "stems": True, "age": age}
    index = [e for e in index if e["id"] != song_id] + [entry]
    _write_json(index_path, index)
    print(f"{song_id}: {duration_s:.2f} s in {time.monotonic() - started:.0f} s; {json.dumps(quality, ensure_ascii=False)}",
          flush=True)
    return quality


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="perepev_worker.catalog", description="Perepev catalog tools")
    commands = parser.add_subparsers(dest="command", required=True)
    stems = commands.add_parser("stems", help="instrumental and guide-vocal stems for indexed songs")
    stems.add_argument("songs_dir", type=Path)
    stems.add_argument("--ids", nargs="+", help="only these song ids (must be in index.json)")
    stems.add_argument("--force", action="store_true", help="redo songs that already have stems")
    imp = commands.add_parser("import", help="a karaoke song from a free recording and its known lyrics")
    imp.add_argument("audio", type=Path)
    imp.add_argument("--id", required=True, dest="song_id")
    imp.add_argument("--clip", required=True, help="A,B: start and end of the sung section in seconds")
    imp.add_argument("--lyrics", required=True, type=Path, help="lyrics of the clip, one sung line per line")
    imp.add_argument("--language", required=True, choices=sorted(CATEGORY))
    imp.add_argument("--credits", required=True, type=Path, help="credits.json: source, licence, authors, review")
    imp.add_argument("--title")
    imp.add_argument("--artist")
    imp.add_argument("--age", required=True, choices=AGES, help="age label shown on the song card (no default)")
    imp.add_argument("--lead", type=float, default=1.0, help="seconds of silence before the clip (default 1.0)")
    imp.add_argument("--songs-dir", type=Path, default=Path(__file__).resolve().parents[2] / "web" / "static" / "songs")
    imp.add_argument("--no-prompt", action="store_true", help="do not hint whisper with the known lyrics")
    imp.add_argument("--force", action="store_true", help="replace a song with the same id")
    args = parser.parse_args(argv)
    if args.command == "stems":
        run_stems(args.songs_dir, args.ids, force=args.force)
        return 0
    try:
        run_import(args.audio, args.song_id, parse_clip(args.clip), args.lyrics.read_text(encoding="utf-8"),
                   args.language, _read_json(args.credits), args.songs_dir, title=args.title, artist=args.artist,
                   age=args.age, lead_s=args.lead, force=args.force, prompt=not args.no_prompt)
    except ValueError as err:
        raise SystemExit(f"catalog import: {err}") from err
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
