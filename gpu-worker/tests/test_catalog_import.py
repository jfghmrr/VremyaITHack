"""`catalog import` with tiny synthetic fixtures and fake models (no downloads)."""
import hashlib
import json

import numpy as np
import pytest

from perepev_worker.align import align_known, parse_lyrics
from perepev_worker.audio import load_audio, write_mp3
from perepev_worker.catalog import main, parse_clip, run_import
from perepev_worker.words import AsrWord

SR = 44100
LYRICS = """# comment lines are ignored
Silent night, holy night,
All is calm, all is bright
Round yon Virgin, Mother and Child
"""
# Sung word onsets in the source recording (seconds); the clip below is 10..28 s.
SUNG = [("Silent", 11.0), ("night,", 11.6), ("holy", 12.6), ("night,", 13.2),
        ("All", 15.0), ("is", 15.5), ("calm,", 16.0), ("all", 17.0), ("is", 17.5), ("bright", 18.0),
        ("Round", 20.0), ("yon", 20.6), ("Virgin,", 21.2), ("Mother", 22.4), ("and", 23.2), ("Child", 23.8)]


def credits():
    return {"title": "Silent Night", "artist": "Test Choir", "credits": "Franz Gruber (music), Joseph Mohr (words)",
            "source": "https://commons.wikimedia.org/wiki/File:Test.mp3",
            "download": "https://commons.wikimedia.org/wiki/Special:FilePath/Test.mp3",
            "license": "Public domain", "licenseUrl": "https://creativecommons.org/publicdomain/mark/1.0/",
            "lyricsSource": "https://en.wikisource.org/wiki/Silent_Night", "reviewedAt": "2026-10-16",
            "review": {"lyrics": "ok", "foreignAgents": "no match", "extremistMaterials": "no match"}}


def make_recording(path, seconds=32.0):
    """A 'singer' (220 Hz tone) during sung words over a quiet 'band' (low hum)."""
    t = np.arange(int(seconds * SR)) / SR
    voice = np.zeros_like(t)
    for _, onset in SUNG:
        on = (t >= onset) & (t < onset + 0.45)
        voice[on] = 0.4 * np.sin(2 * np.pi * 220 * t[on])
    band = 0.05 * np.sin(2 * np.pi * 55 * t)
    write_mp3(path, np.stack([voice + band] * 2, axis=1), SR)


def fake_separate(y, sr):
    t = np.arange(len(y)) / sr
    band = 0.05 * np.sin(2 * np.pi * 55 * t)[:, None]
    return y - band, np.repeat(band, y.shape[1], axis=1)


def fake_f0(y, sr):
    """A 'melody' wherever the vocal is loud, like torchcrepe on a clean voice."""
    hop = sr // 100
    frames = []
    for i in range(int(np.ceil(len(y) / hop))):
        chunk = y[i * hop:(i + 1) * hop]
        frames.append((round(i * 0.01, 2), 57.0 if len(chunk) and np.abs(chunk).max() > 0.1 else None))
    return frames


def fake_transcriber(clip_start, lead, drop=()):
    calls = []

    def transcribe(y, sr, language, beam_size=None, prompt=None):
        calls.append({"language": language, "prompt": prompt, "seconds": len(y) / sr})
        words = []
        for k, (text, onset) in enumerate(SUNG):
            if k in drop:
                continue
            start = onset - clip_start + lead
            words.append(AsrWord(text=text.strip(",").lower(), start_s=start, end_s=start + 0.4))
        return words + [AsrWord("thank", 17.9, 18.0)]  # a stray hallucination after the singing

    transcribe.calls = calls
    return transcribe


@pytest.fixture
def songs(tmp_path):
    d = tmp_path / "songs"
    d.mkdir()
    (d / "index.json").write_text(json.dumps([{"id": "old-song", "title": "Old"}]) + "\n")
    rec = tmp_path / "rec.mp3"
    make_recording(rec)
    return d, rec


def imported(songs, **kw):
    d, rec = songs
    transcriber = kw.pop("transcriber", fake_transcriber(10.0, 1.0))
    quality = run_import(rec, "silent-night-test", (10.0, 28.0), LYRICS, "en", credits(), d, age="0+", lead_s=1.0,
                         separator=fake_separate, f0=fake_f0, transcriber=transcriber, **kw)
    return d / "silent-night-test", quality, transcriber


def test_parse_lyrics_and_clip():
    assert parse_lyrics(LYRICS) == [["Silent", "night,", "holy", "night,"], ["All", "is", "calm,", "all", "is", "bright"],
                                    ["Round", "yon", "Virgin,", "Mother", "and", "Child"]]
    assert parse_lyrics("a — b\n\n  \n") == [["a", "b"]]
    assert parse_clip("10.5,40") == (10.5, 40.0)
    for bad in ("10", "a,b", "30,20", "-1,5"):
        with pytest.raises(ValueError):
            parse_clip(bad)


def test_align_known_interpolates_unmatched_words_between_anchors():
    lines = [["one", "two", "three", "four"], ["five", "six"]]
    asr = [AsrWord("one", 1.0, 1.3), AsrWord("four", 3.0, 3.3), AsrWord("six", 5.0, 5.4)]
    result = align_known(lines, asr, start_s=0.5, end_s=8.0)
    assert result.matched == 3 and result.total == 6
    flat = [w for line in result.lines for w in line]
    assert [w.text for w in flat] == ["one", "two", "three", "four", "five", "six"]
    assert flat[0].start_s == 1.0 and flat[3].start_s == 3.0 and flat[5].start_s == 5.0
    assert 1.3 <= flat[1].start_s < flat[2].start_s < 3.0  # "two", "three" fill the gap
    assert 3.3 <= flat[4].start_s < 5.0
    previous = 0.5
    for w in flat:
        assert w.start_s >= previous and w.end_s > w.start_s and w.end_s <= 8.0
        previous = w.end_s


def test_align_known_shares_a_stretched_anchor_with_the_missing_words():
    # Whisper stretched the first word to the next recognised word; words 2 and 3 were not recognised.
    lines = [["Mira,", "mira,", "ola", "stella,"], ["Stella", "lumen"]]
    asr = [AsrWord("Mira", 3.84, 5.30), AsrWord("stella", 5.34, 6.0), AsrWord("Stella", 7.0, 7.5), AsrWord("lumen", 7.6, 8.0)]
    flat = [w for line in align_known(lines, asr, start_s=1.0, end_s=10.0).lines for w in line]
    assert flat[0].start_s == 3.84 and flat[3].start_s == 5.34
    assert all(w.end_s - w.start_s >= 0.3 for w in flat[:3])
    assert all(x.end_s <= y.start_s for x, y in zip(flat, flat[1:]))


def test_align_known_without_any_recognised_word_spreads_over_the_clip():
    result = align_known([["a", "b"], ["c"]], [], start_s=1.0, end_s=4.0)
    flat = [w for line in result.lines for w in line]
    assert result.matched == 0 and flat[0].start_s == 1.0 and flat[-1].end_s <= 4.0
    assert all(x.end_s <= y.start_s for x, y in zip(flat, flat[1:]))


def test_import_writes_karaoke_files_index_and_credits(songs):
    dest, quality, transcriber = imported(songs)
    d = songs[0]
    duration = 19.0  # 18 s clip + 1 s lead
    ref = json.loads((dest / "reference.json").read_text())
    assert ref["id"] == "silent-night-test" and ref["title"] == "Silent Night" and ref["artist"] == "Test Choir"
    assert ref["hop_ms"] == 10 and ref["duration_s"] == duration and ref["backing"] == "backing.mp3"
    assert len(ref["f0_midi"]) == 1900
    # The known lyrics, not the recognised text, with the line breaks of lyrics.txt.
    assert [line["text"] for line in ref["lyrics"]] == ["Silent night, holy night,", "All is calm, all is bright",
                                                        "Round yon Virgin, Mother and Child"]
    assert ref["lyrics"][0]["t"] == pytest.approx(2.0, abs=0.01)  # 11.0 - 10.0 + 1.0 lead
    assert ref["lyrics"][2]["t"] == pytest.approx(11.0, abs=0.01)
    timing = json.loads((dest / "lyrics.words.json").read_text())
    assert timing["v"] == 1 and len(timing["lines"]) == 3
    for i, line in enumerate(timing["lines"]):
        assert " ".join(w["text"] for w in line["words"]) == ref["lyrics"][i]["text"]
        assert abs(line["words"][0]["start_s"] - ref["lyrics"][i]["t"]) <= 0.02
    # Melody only around lyric lines: the lead-in and the tail are silent.
    assert all(m is None for m in ref["f0_midi"][:150]) and ref["f0_midi"][205] == 57.0
    assert all(m is None for m in ref["f0_midi"][1600:])

    backing, inst, guide = (load_audio(dest / n, SR, mono=False) for n in ("backing.mp3", "instrumental.mp3", "guide.mp3"))
    assert backing.shape == inst.shape == guide.shape
    assert abs(len(backing) / SR - duration) < 0.03
    assert np.abs(backing[: int(0.9 * SR)]).max() < 1e-3  # the lead is silence

    credits_out = json.loads((dest / "CREDITS.json").read_text())
    assert credits_out["clip"] == {"start_s": 10.0, "end_s": 28.0, "lead_s": 1.0}
    assert credits_out["download"].startswith("https://") and credits_out["review"]["lyrics"] == "ok"
    assert credits_out["sourceSha256"] == hashlib.sha256(songs[1].read_bytes()).hexdigest()
    for name in ("backing.mp3", "instrumental.mp3", "guide.mp3", "reference.json", "lyrics.words.json"):
        assert credits_out["files"][name] == hashlib.sha256((dest / name).read_bytes()).hexdigest()
    assert credits_out["age"] == "0+" and "htdemucs" in credits_out["preparation"]["separation"]

    index = json.loads((d / "index.json").read_text())
    assert [e["id"] for e in index] == ["old-song", "silent-night-test"]
    entry = index[1]
    assert entry["stems"] is True and entry["hasVocals"] is True and entry["age"] == "0+"
    assert entry["language"] == "en" and entry["category"] == "English" and entry["duration_s"] == duration
    assert entry["license"] == "Public domain" and 20 <= len(entry["contour"]) <= 100

    assert quality["wordsMatched"] == 16 and quality["wordsTotal"] == 16
    assert quality["wordsMonotonic"] and quality["wordsInsideClip"]
    assert quality["voicedInLines"] > 0.5 and quality["guideOverInstrumentalDb"] > 6
    assert quality["guideOverInstrumentalVoiceBandDb"] > 20  # the 'band' is a 55 Hz hum
    assert transcriber.calls[0]["language"] == "en" and "holy night" in transcriber.calls[0]["prompt"]


def test_import_interpolates_words_whisper_missed(songs):
    dest, quality, _ = imported(songs, transcriber=fake_transcriber(10.0, 1.0, drop={2, 7, 12}))
    assert quality["wordsMatched"] == 13
    words = [w for line in json.loads((dest / "lyrics.words.json").read_text())["lines"] for w in line["words"]]
    assert [w["text"] for w in words][2] == "holy"
    assert words[1]["end_s"] <= words[2]["start_s"] < words[3]["start_s"]


def test_import_refuses_existing_ids_bad_clips_and_obscene_lyrics(songs):
    d, rec = songs
    args = dict(age="0+", separator=fake_separate, f0=fake_f0, transcriber=fake_transcriber(10.0, 1.0))
    with pytest.raises(ValueError, match="already exists"):
        run_import(rec, "old-song", (10.0, 28.0), LYRICS, "en", credits(), d, **args)
    with pytest.raises(ValueError, match="15-60"):
        run_import(rec, "short", (10.0, 15.0), LYRICS, "en", credits(), d, **args)
    with pytest.raises(ValueError, match="past the recording"):
        run_import(rec, "late", (20.0, 50.0), LYRICS, "en", credits(), d, **args)
    with pytest.raises(ValueError, match="obscene"):
        run_import(rec, "rude", (10.0, 28.0), LYRICS + "what the fuck\n", "en", credits(), d, **args)
    incomplete = credits()
    del incomplete["review"]
    with pytest.raises(ValueError, match="review"):
        run_import(rec, "no-review", (10.0, 28.0), LYRICS, "en", incomplete, d, **args)
    with pytest.raises(ValueError, match="age"):
        run_import(rec, "adult", (10.0, 28.0), LYRICS, "en", credits(), d, **{**args, "age": "18+"})
    # "my-<id>" is a user's own track on the site and in the API.
    with pytest.raises(ValueError, match="reserved"):
        run_import(rec, "my-song", (10.0, 28.0), LYRICS, "en", credits(), d, **args)
    assert json.loads((d / "index.json").read_text()) == [{"id": "old-song", "title": "Old"}]
    assert not any(p.name != "index.json" for p in d.iterdir())


def test_import_force_replaces_the_entry_once(songs):
    imported(songs)
    imported(songs, force=True)
    index = json.loads((songs[0] / "index.json").read_text())
    assert [e["id"] for e in index] == ["old-song", "silent-night-test"]


def test_cli_import_reports_errors_without_traceback(songs, tmp_path):
    d, rec = songs
    (tmp_path / "lyrics.txt").write_text(LYRICS)
    (tmp_path / "credits.json").write_text(json.dumps(credits()))
    with pytest.raises(SystemExit, match="15-60"):
        main(["import", str(rec), "--id", "x", "--clip", "1,3", "--lyrics", str(tmp_path / "lyrics.txt"),
              "--language", "en", "--credits", str(tmp_path / "credits.json"), "--age", "0+", "--songs-dir", str(d)])


def test_cli_import_requires_an_explicit_age_label(songs, tmp_path, capsys):
    # No silent "0+": the age label is a reviewed decision for every song.
    d, rec = songs
    (tmp_path / "lyrics.txt").write_text(LYRICS)
    (tmp_path / "credits.json").write_text(json.dumps(credits()))
    with pytest.raises(SystemExit) as exit_info:
        main(["import", str(rec), "--id", "x", "--clip", "10,28", "--lyrics", str(tmp_path / "lyrics.txt"),
              "--language", "en", "--credits", str(tmp_path / "credits.json"), "--songs-dir", str(d)])
    assert exit_info.value.code == 2 and "--age" in capsys.readouterr().err
    with pytest.raises(TypeError):
        run_import(rec, "x", (10.0, 28.0), LYRICS, "en", credits(), d, separator=fake_separate, f0=fake_f0,
                   transcriber=fake_transcriber(10.0, 1.0))
    assert not (d / "x").exists()
