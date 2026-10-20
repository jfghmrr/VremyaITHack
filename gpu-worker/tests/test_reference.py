import json
import math

from perepev_worker.track import build_reference, build_word_timing, clean_words, group_lines
from perepev_worker.words import AsrWord


def words_at(starts, length=0.3, text="слово"):
    return [AsrWord(text=f"{text}{i}", start_s=s, end_s=s + length) for i, s in enumerate(starts)]


def test_group_lines_splits_on_pause_and_long_lines():
    # Ten evenly spaced words have no pause to prefer: the line is halved, not cut after 8 words.
    words = words_at([0.5, 0.9, 1.3, 2.6, 3.0] + [5.0 + 0.4 * i for i in range(10)])
    lines = group_lines(words)
    assert [len(line) for line in lines] == [3, 2, 5, 5]


def test_clean_words_makes_times_monotonic_and_trims_to_duration():
    raw = [AsrWord(" Пусть", 1.0, 1.2), AsrWord("в", 1.1, 1.1), AsrWord("  ", 1.3, 1.4),
           AsrWord("твоей", 1.25, 1.6), AsrWord("памяти", 9.8, 10.4)]
    words = clean_words(raw, duration_s=10.0)
    assert [w.text for w in words] == ["Пусть", "в", "твоей", "памяти"]
    previous = 0.0
    for w in words:
        assert w.start_s >= previous and w.end_s > w.start_s and w.end_s <= 10.0
        previous = w.end_s


def test_reference_json_shape():
    duration = 13.87
    frames = [(i * 0.01, 60.0 if 100 <= i < 300 else None) for i in range(1390)]
    lines = group_lines(words_at([1.0, 1.4, 1.8, 4.0, 4.4]))
    ref = build_reference("my-1234", "Мой трек", duration, frames, lines)
    assert ref["hop_ms"] == 10
    assert len(ref["f0_midi"]) == math.ceil(duration / 0.01)
    assert ref["duration_s"] == duration
    assert ref["id"] == "my-1234" and ref["title"] == "Мой трек" and ref["backing"] == "backing.mp3"
    assert ref["f0_midi"][150] == 60.0 and ref["f0_midi"][50] is None
    assert len(ref["phrases"]) == len(ref["lyrics"]) == 2
    assert ref["lyrics"][0] == {"t": 1.0, "text": "слово0 слово1 слово2"}
    assert ref["phrases"][0] == {"start_s": 1.0, "end_s": 2.1}
    json.dumps(ref, allow_nan=False)


def test_word_timing_matches_reference_lyrics():
    # The same invariants as web/src/lib/lyrics.ts parseWordTiming.
    lines = group_lines(words_at([1.0, 1.4, 1.8, 4.0, 4.4]))
    ref = build_reference("my-1", "t", 6.0, [], lines)
    timing = build_word_timing(lines)
    assert timing["v"] == 1 and len(timing["lines"]) == len(ref["lyrics"])
    previous = 0.0
    for i, line in enumerate(timing["lines"]):
        assert line["line"] == i
        assert abs(line["words"][0]["start_s"] - ref["lyrics"][i]["t"]) <= 0.02
        assert " ".join(w["text"] for w in line["words"]) == ref["lyrics"][i]["text"]
        for w in line["words"]:
            assert w["start_s"] >= previous and w["end_s"] > w["start_s"] and w["end_s"] <= ref["duration_s"]
            previous = w["end_s"]


def test_reference_without_words_is_still_valid():
    ref = build_reference("my-2", "Без слов", 20.0, [(0.0, 57.0)], [])
    assert ref["lyrics"] == [] and ref["phrases"] == []
    assert len(ref["f0_midi"]) == 2000
