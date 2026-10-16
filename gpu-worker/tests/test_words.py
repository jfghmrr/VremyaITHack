from perepev_worker.words import AsrWord, LyricWord, match_words, normalize


def lyric(texts, start=1.0, step=0.5):
    return [LyricWord(index=i, line=0, text=t, start_s=start + i * step, end_s=start + i * step + 0.4)
            for i, t in enumerate(texts)]


def asr_from(words):
    return [AsrWord(text=w.text, start_s=w.start_s + 0.05, end_s=w.end_s) for w in words]


def test_normalize_folds_case_yo_and_punctuation():
    assert normalize("Ждёт,") == "ждет"
    assert normalize("«Тебя!»") == "тебя"
    assert normalize("Don't") == "dont"
    assert normalize("кто-то") == "ктото"


def test_match_words_exact():
    words = lyric(["Пусть", "в", "твоей", "памяти", "нетленный"])
    evidence = match_words(words, asr_from(words))
    assert [e.index for e in evidence] == [0, 1, 2, 3, 4]
    for e, w in zip(evidence, words):
        assert abs(e.sung - 1.0) < 1e-9
        assert abs(e.onset_s - (w.start_s + 0.05)) < 1e-9


def test_match_words_humming():
    words = lyric(["Маленький", "шарик", "ждёт", "тебя"])
    evidence = match_words(words, [])
    assert [e.index for e in evidence] == [0, 1, 2, 3]
    assert all(e.sung == 0.0 and e.onset_s is None for e in evidence)


def test_match_words_reordered_tolerant():
    words = lyric(["Верь", "мне", "что", "ты", "во", "всей", "вселенной"])
    asr = asr_from(words)
    asr[3] = AsrWord(text="мы", start_s=asr[3].start_s, end_s=asr[3].end_s)  # one substituted word
    evidence = match_words(words, asr)
    assert evidence[3].sung == 0.0 and evidence[3].onset_s is None
    for i in (0, 1, 2, 4, 5, 6):
        assert evidence[i].sung >= 0.99, i
        assert evidence[i].onset_s is not None


def test_match_words_fuzzy_spelling_counts_partially():
    words = lyric(["вселенной"])
    evidence = match_words(words, [AsrWord(text="вселеной", start_s=1.0, end_s=1.4)])
    assert 0.7 <= evidence[0].sung < 1.0


def test_match_words_ignores_far_away_repeats():
    # The same word sung 10 s later must not count for this lyric word.
    words = lyric(["земля"], start=2.0)
    evidence = match_words(words, [AsrWord(text="земля", start_s=12.0, end_s=12.4)])
    assert evidence[0].sung == 0.0


def test_match_words_repeated_chorus_takes_nearest():
    words = lyric(["ла", "любовь", "ла", "любовь"], start=1.0, step=2.0)
    asr = [AsrWord("любовь", 3.0, 3.4), AsrWord("любовь", 7.1, 7.5)]
    evidence = match_words(words, asr)
    assert evidence[1].onset_s == 3.0
    assert evidence[3].onset_s == 7.1
    assert evidence[0].sung == 0.0 and evidence[2].sung == 0.0


def test_masked_lyric_word_matches_the_sung_word():
    # Own-track lyrics are shown masked ("б****"); singing the real word must still count.
    words = lyric(["ну", "б****", "опять"])
    asr = [AsrWord("ну", 1.05, 1.4), AsrWord("блядь", 1.55, 1.9), AsrWord("опять", 2.05, 2.4)]
    evidence = match_words(words, asr)
    assert [e.sung for e in evidence] == [1.0, 1.0, 1.0]
    assert evidence[1].onset_s == 1.55


def test_masked_lyric_word_does_not_match_a_clean_word():
    words = lyric(["ну", "б****"])
    evidence = match_words(words, [AsrWord("ну", 1.05, 1.4), AsrWord("белый", 1.55, 1.9)])
    assert evidence[1].sung == 0.0 and evidence[1].onset_s is None
