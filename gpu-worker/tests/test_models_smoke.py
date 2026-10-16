"""Slow end-to-end checks with real models on the catalog's own CC-licensed clip."""
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from perepev_worker.audio import load_audio
from perepev_worker.words import normalize

SONG = Path(__file__).resolve().parents[2] / "web/static/songs/cn-earth"
SR = 44100


def write_wav(path, y, sr):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


@pytest.mark.models
def test_separate_returns_aligned_stems():
    from perepev_worker.separate import separate

    mix = load_audio(SONG / "backing.mp3", SR, mono=False)[: SR * 6]
    vocals, instrumental = separate(mix, SR)
    assert vocals.shape == instrumental.shape == mix.shape
    # The stems add back up to (nearly) the mix.
    residual = np.sqrt(np.mean((vocals + instrumental - mix) ** 2)) / np.sqrt(np.mean(mix ** 2))
    assert residual < 0.2


@pytest.mark.models
def test_process_track_smoke_on_catalog_clip(tmp_path):
    from perepev_worker.track import process_track

    mix = load_audio(SONG / "backing.mp3", SR)
    margin = np.zeros(2 * SR, dtype=np.float32)
    write_wav(tmp_path / "in.wav", np.concatenate([margin, mix, margin]), SR)
    result = process_track(tmp_path / "in.wav", "ru", "Земное притяжение", margin_s=2.0, song_id="my-smoke")
    assert set(result.files) == {"instrumental.mp3", "guide.mp3", "backing.mp3", "reference.json", "lyrics.words.json"}
    ref = json.loads(result.files["reference.json"])
    assert ref["id"] == "my-smoke" and ref["hop_ms"] == 10
    assert abs(ref["duration_s"] - 13.87) <= 0.02
    assert sum(m is not None for m in ref["f0_midi"]) > len(ref["f0_midi"]) * 0.2
    known = [normalize(w["text"]) for line in json.loads((SONG / "lyrics.words.json").read_text())["lines"] for w in line["words"]]
    got = {normalize(w) for line in ref["lyrics"] for w in line["text"].split()}
    overlap = sum(w in got for w in known) / len(known)
    print(f"word overlap {overlap:.0%}: {[line['text'] for line in ref['lyrics']]}")
    assert overlap >= 0.5
    assert result.output["lines"] == len(ref["lyrics"]) and result.output["words"] >= 10
