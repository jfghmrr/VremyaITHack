import pytest

from perepev_worker.profanity import mask


@pytest.mark.parametrize("text", ["ну нахуй это", "Пиздец какой", "заебал уже", "Блядь!", "what the fuck", "Bullshit, man", "ну ебу",
                                  "охуеть можно", "мне похуй", "хуйня какая",
                                  # the prefixes не, в, вы of the anchored «ху» root
                                  "нехуй тут делать", "живём нехуёво", "выхуярил всё", "вхуярил гвоздь"])
def test_profanity_masks_root(text):
    masked, count = mask(text)
    assert count == 1
    assert "*" in masked
    assert len(masked) == len(text)


def test_profanity_keeps_first_letter_and_punctuation():
    assert mask("Блядь!") == ("Б****!", 1)
    assert mask("fucking great") == ("f****** great", 1)


@pytest.mark.parametrize("text", [
    "Небо над землёю", "себе и тебе, себя", "ребёнок колеблется", "застрахуй машину", "кусок хлеба", "употребляя слова", "мандарин", "худо без друга",
    "оскорблять нельзя", "истреблять и углублять", "тихую ночь", "плохую погоду", "сухую траву", "глухую стену",
    "лихую тройку", "он психует", "не психуй", "хуже некуда", "похудеть", "хулиган", "нехудой кот", "выхухоль",
    "ухудшить", "прохудилась", "Shitake mushrooms? no, shiitake", "Scunthorpe", "assumption", "cocktail",
])
def test_profanity_leaves_clean_words(text):
    assert mask(text) == (text, 0)


def test_profanity_counts_each_word():
    assert mask("хуй и пизда")[1] == 2
