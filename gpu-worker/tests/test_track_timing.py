"""Own-track word timing without models: hallucinated segments, vocal activity, trimming, line splits."""
import numpy as np

from perepev_worker.track import (
    MAX_LINE_WORDS,
    drop_silent_words,
    group_lines,
    refine_word_times,
    vocal_activity,
)
from perepev_worker.words import AsrSegment, AsrWord, is_hallucination, keep_sung


def active_between(*spans, n=1000, hop=0.01):
    """Boolean activity on a 10 ms grid, True inside [a, b) seconds."""
    active = np.zeros(n, dtype=bool)
    for a, b in spans:
        active[round(a / hop):round(b / hop)] = True
    return active


def test_whisper_hallucinations_on_music_are_recognised():
    for text in ["Продолжение следует...", "Субтитры сделал DimaTorzok", "Редактор субтитров А.Синецкая Корректор А.Егорова",
                 "Спасибо за просмотр!", "ПОДПИСЫВАЙТЕСЬ НА КАНАЛ", "ПЕСНЯ", "МУЗЫКА", "Динамичная музыка", "[музыка]",
                 "(аплодисменты)", "♪", "♪ ♪", "♪ [Music] ♪", "(Припев)", "Thank you for watching!", "Thanks for watching.",
                 "Subtitles by the Amara.org community", "[Music]", "Please subscribe to my channel",
                 "♪ Music ♪", "♪ музыка ♪", "♪ Applause ♪", "♪ аплодисменты ♪"]:
        assert is_hallucination(text), text


def test_sung_lines_are_not_hallucinations():
    # Whisper writes sung lyrics between ♪ and adds section markers (whisper.cpp #1240);
    # bare ordinary words like «песня» in sentence case are lyrics, not sound labels.
    for text in ["Музыка нас связала", "Я пою эту песню тебе", "Продолжаем петь до утра", "Thank you for the music",
                 "Watching the river flow", "Спасибо, сердце, что ты умеешь так любить", "Субботний вечер",
                 "♪ You have been warned ♪", "♪ Я люблю тебя, моя Россия ♪", "(Припев) Я люблю тебя (х2)",
                 "Новая песня", "Любимая песня", "НОВАЯ ПЕСНЯ", "Песня", "Музыка", "Music"]:
        assert not is_hallucination(text), text


def test_keep_sung_drops_whole_hallucinated_segments():
    sung = AsrSegment("Я пою", [AsrWord("Я", 1.0, 1.2), AsrWord("пою", 1.2, 1.8)])
    junk = AsrSegment("Продолжение следует...", [AsrWord("Продолжение", 20.0, 21.0), AsrWord("следует...", 21.0, 22.0)])
    assert keep_sung([sung, junk]) == sung.words


def test_keep_sung_keeps_lyrics_without_music_signs_and_markers():
    notes = AsrSegment("♪ Я люблю тебя ♪", [AsrWord("♪Я", 1.0, 1.2), AsrWord("люблю", 1.2, 1.6), AsrWord("тебя♪", 1.6, 2.0)])
    chorus = AsrSegment("(Припев) Я люблю тебя (х2)", [AsrWord("(Припев)", 3.0, 3.5), AsrWord("Я", 3.5, 3.7),
                                                         AsrWord("люблю", 3.7, 4.0), AsrWord("тебя", 4.0, 4.4), AsrWord("(х2)", 4.4, 4.6)])
    spread = AsrSegment("(Припев: два раза) пой", [AsrWord("(Припев:", 5.0, 5.2), AsrWord("два", 5.2, 5.4),
                                                     AsrWord("раза)", 5.4, 5.6), AsrWord("пой", 5.6, 6.0), AsrWord("x2", 6.0, 6.2), AsrWord("×3", 6.2, 6.4)])
    words = keep_sung([notes, chorus, spread])
    assert [w.text for w in words] == ["Я", "люблю", "тебя", "Я", "люблю", "тебя", "пой"]
    assert (words[0].start_s, words[2].end_s) == (1.0, 2.0)


def test_vocal_activity_gates_relative_to_loud_parts_and_has_an_absolute_floor():
    level = np.full(300, 1e-4)
    level[50:150] = 0.2
    level[200:202] = 0.2  # a 20 ms blip
    level[100:110] = 1e-4  # a 100 ms gap inside singing
    active = vocal_activity(level)
    assert active[60] and active[140]
    assert active[105], "short gaps between syllables are closed"
    assert not active[201], "blips shorter than 50 ms are dropped"
    assert not active[0] and not active[250]
    assert not vocal_activity(np.full(300, 5e-4)).any(), "residue below about -60 dBFS is never singing"


def test_refine_trims_silence_that_whisper_glued_to_words():
    active = active_between((1.5, 2.0), (2.1, 3.0))
    words = [AsrWord("раз", 0.4, 2.0), AsrWord("два", 2.0, 3.0), AsrWord("три", 3.0, 5.5)]
    out = refine_word_times(words, active)
    assert out[0].start_s >= 1.4 and out[0].end_s == 2.0, "the first word started 1.1 s before the voice"
    assert out[1] == words[1], "a 0.1 s gap is not trimmed"
    assert out[2] == words[2], "no voice inside: left to drop_silent_words"


def test_refine_keeps_order_and_never_extends():
    active = active_between((0.0, 10.0))
    words = [AsrWord("a", 1.0, 1.5), AsrWord("b", 1.5, 2.0)]
    assert refine_word_times(words, active) == words


def test_drop_silent_words_only_far_from_any_voice():
    active = active_between((1.0, 3.0))
    words = [AsrWord("рядом", 3.2, 3.5), AsrWord("эхо", 3.6, 3.9), AsrWord("титры", 8.0, 9.0)]
    kept = drop_silent_words(words, active)
    assert [w.text for w in kept] == ["рядом", "эхо"]


def test_group_lines_splits_long_lines_at_the_widest_pause():
    # 10 words with one 0.3 s breath after the 6th: the split goes there, not after 8 words.
    starts = [0.0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.6, 3.0, 3.4, 3.8]
    words = [AsrWord(f"с{i}", s, s + 0.3) for i, s in enumerate(starts)]
    assert [len(line) for line in group_lines(words)] == [6, 4]
    assert all(len(line) <= MAX_LINE_WORDS for line in group_lines(words))


def test_group_lines_splits_lines_that_run_too_long():
    words = [AsrWord(f"т{i}", i * 1.5, i * 1.5 + 1.4) for i in range(6)]  # 8.9 s without a 0.6 s pause
    lines = group_lines(words)
    assert len(lines) == 2
    assert all(line[-1].end_s - line[0].start_s <= 7.0 for line in lines)


def test_process_track_drops_hallucinations_and_trims_word_times(tmp_path, monkeypatch):
    """The own-track pipeline with fake models: only the timing code is real."""
    import json
    import math

    import soundfile as sf

    from perepev_worker import pitch, separate, words
    from perepev_worker.track import process_track

    sr, margin = 44100, 0.5
    t = np.arange(int((10 + 2 * margin) * sr)) / sr
    voice = np.zeros_like(t, dtype=np.float32)
    for a, b in [(1.0, 3.0), (5.0, 6.0)]:  # singing, in section time
        on = (t >= a + margin) & (t < b + margin)
        voice[on] = 0.3 * np.sin(2 * np.pi * 220 * t[on])
    sf.write(tmp_path / "in.wav", voice, sr, subtype="PCM_16")

    monkeypatch.setattr(separate, "separate", lambda mix, rate: (mix.copy(), mix * 0.0))
    monkeypatch.setattr(pitch, "f0_frames", lambda y, rate: [(round(i * 0.01, 2), 57.0) for i in range(math.ceil(len(y) / rate / 0.01))])
    monkeypatch.setattr(words, "asr_model_name", lambda: "fake")
    monkeypatch.setattr(words, "transcribe_segments", lambda *a, **k: [
        AsrSegment("Привет мир", [AsrWord("Привет", 0.2, 1.8), AsrWord("мир", 1.8, 3.0)]),
        AsrSegment("снова", [AsrWord("снова", 5.0, 6.0)]),
        AsrSegment("Продолжение следует...", [AsrWord("Продолжение", 7.5, 8.5), AsrWord("следует...", 8.5, 9.4)]),
        AsrSegment("эхо", [AsrWord("эхо", 9.4, 9.8)]),
    ])
    result = process_track(tmp_path / "in.wav", "ru", "Тест", margin_s=margin, song_id="my-test")
    reference = json.loads(result.files["reference.json"])
    timing = json.loads(result.files["lyrics.words.json"])
    assert [line["text"] for line in reference["lyrics"]] == ["Привет мир", "снова"]
    assert 0.85 <= reference["lyrics"][0]["t"] <= 1.0, "the word no longer starts 0.8 s before the voice"
    assert reference["lyrics"][1]["t"] == 5.0
    assert timing["lines"][0]["words"][0]["start_s"] == reference["lyrics"][0]["t"]
    assert result.output["dropped_words"] == 3
