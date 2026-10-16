import hashlib
import json

import numpy as np
import pytest

from perepev_worker.audio import load_audio, write_mp3
from perepev_worker.catalog import main, run_stems

SR = 44100


def fake_separate(y, sr):
    return y * 0.25, y * 0.75


def make_song(root, song_id):
    d = root / song_id
    d.mkdir()
    t = np.arange(SR * 2) / SR
    write_mp3(d / "backing.mp3", np.stack([np.sin(2 * np.pi * 220 * t)] * 2, axis=1) * 0.4, SR)
    credits = {"id": song_id, "preparation": {"by": "mugsize"},
               "files": {"backing.mp3": hashlib.sha256((d / "backing.mp3").read_bytes()).hexdigest()}}
    (d / "CREDITS.json").write_text(json.dumps(credits, ensure_ascii=False, separators=(",", ":")) + "\n")
    (d / "reference.json").write_text('{"id":"%s"}\n' % song_id)


@pytest.fixture
def songs(tmp_path):
    for song_id in ("song-a", "song-b", "legacy"):
        make_song(tmp_path, song_id)
    index = [{"id": "song-a", "title": "А", "contour": [None, 50.1]}, {"id": "song-b", "title": "B"}]
    (tmp_path / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n")
    return tmp_path


def test_stems_written_and_index_flagged(songs):
    reference_before = (songs / "song-a" / "reference.json").read_bytes()
    run_stems(songs, separator=fake_separate)
    for song_id in ("song-a", "song-b"):
        d = songs / song_id
        guide = load_audio(d / "guide.mp3", SR, mono=False)
        inst = load_audio(d / "instrumental.mp3", SR, mono=False)
        backing = load_audio(d / "backing.mp3", SR, mono=False)
        assert guide.shape == inst.shape == backing.shape
        credits = json.loads((d / "CREDITS.json").read_text())
        for name in ("guide.mp3", "instrumental.mp3", "backing.mp3"):
            assert credits["files"][name] == hashlib.sha256((d / name).read_bytes()).hexdigest()
        assert "htdemucs" in credits["preparation"]["stems"]
    text = (songs / "index.json").read_text()
    index = json.loads(text)
    assert [e["stems"] for e in index] == [True, True]
    assert index[0]["contour"] == [None, 50.1]
    assert text == json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n"
    assert not (songs / "legacy" / "guide.mp3").exists()
    assert (songs / "song-a" / "reference.json").read_bytes() == reference_before


def test_stems_only_for_requested_ids(songs):
    run_stems(songs, ids=["song-b"], separator=fake_separate)
    index = json.loads((songs / "index.json").read_text())
    assert "stems" not in index[0] and index[1]["stems"] is True
    assert not (songs / "song-a" / "guide.mp3").exists()


def test_stems_refuse_ids_outside_index(songs):
    with pytest.raises(SystemExit):
        run_stems(songs, ids=["legacy"], separator=fake_separate)
    assert not (songs / "legacy" / "guide.mp3").exists()


def test_existing_stems_are_skipped_unless_forced(songs):
    run_stems(songs, ids=["song-a"], separator=fake_separate)
    calls = []

    def counting(y, sr):
        calls.append(1)
        return fake_separate(y, sr)

    run_stems(songs, ids=["song-a"], separator=counting)
    assert calls == []
    run_stems(songs, ids=["song-a"], separator=counting, force=True)
    assert calls == [1]


def test_cli_requires_stems_command(songs):
    with pytest.raises(SystemExit):
        main(["unknown", str(songs)])
