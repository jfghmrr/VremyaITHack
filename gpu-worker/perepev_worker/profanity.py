"""Mask obscene words in recognised lyrics (Russian mat roots and English obscenities).

Each pattern is anchored to a word so that clean words sharing letters
(небо, застрахуй, тихую, психует, употребляя, мандарин, Scunthorpe) stay untouched.
"""
from __future__ import annotations

import re

_PREFIXES = ("за", "на", "по", "под", "пере", "при", "про", "раз", "рас", "вы", "от", "до", "об", "у",
             "въ", "съ", "разъ", "подъ", "объ", "отъ", "изъ", "не", "ни")
_PREFIX = "(?:" + "|".join(_PREFIXES) + ")?"
# The «ху» root takes the same prefixes (нехуй, выхуярил) plus о-, а- and в- (охуеть, ахуеть, вхуярил).
_HU_PREFIX = "(?:" + "|".join(_PREFIXES + ("о", "а", "в")) + ")?"
_PATTERNS = [
    r"\b" + _HU_PREFIX + r"ху[йяеёию]\w*",
    r"\w*пизд\w*",
    r"\b" + _PREFIX + r"[её]б(?:а[тлнй]|у(?:[тнчщ]|$)|л[аиоя]|[иёе]|ыр|ну|ош|ок)\w*",
    r"\w*бляд\w*",
    r"\bблят\w*",
    r"\bбля\b",
    r"\w*муд(?:ак|ач|ил|оз|охал)\w*",
    r"\bманд(?:а|ы|е|у|ой|ою)\b",
    r"\w*залуп\w*",
    r"\w*гандон\w*",
    r"\w*fuck\w*",
    r"\b(?:bull)?shit(?!ake)\w*",
    r"\bcunt\w*",
    r"\bbitch\w*",
    r"\basshole\w*",
    r"\bwhore\w*",
    r"\bslut\w*",
    r"\bnigg(?:a|er)\w*",
]
_WORD = re.compile(r"\w+", re.UNICODE)
_OBSCENE = re.compile("|".join(_PATTERNS), re.IGNORECASE | re.UNICODE)


def _mask_word(match: re.Match) -> str:
    word = match.group(0)
    if not _OBSCENE.search(word):
        return word
    return word[0] + "*" * (len(word) - 1)


def mask(text: str) -> tuple[str, int]:
    """Return the text with obscene words masked (first letter kept) and how many were masked."""
    count = 0

    def replace(match: re.Match) -> str:
        nonlocal count
        masked = _mask_word(match)
        count += masked != match.group(0)
        return masked

    return _WORD.sub(replace, text), count
