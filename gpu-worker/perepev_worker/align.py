"""Word timing for known lyrics: recognised words are anchors, the rest is interpolated.

Used by `catalog import`: the lyric text comes from a public-domain source, the recording
only supplies the timing. Recognised words are matched to the lyric words with the same
fuzzy, monotonic alignment as scoring (`words.match_words`); lyric words without a match
get times interpolated between the neighbouring anchors.
"""
from __future__ import annotations

from dataclasses import dataclass

from .words import AsrWord, LyricWord, match_words, normalize

# Typical sung word length used before the first and after the last anchor.
DEFAULT_WORD_S = 0.45
MIN_WORD_S = 0.05
# Whisper often stretches a sung word's end up to the next recognised word. When the gap
# after an anchor leaves less than this per missing word, the anchor shares its time.
MIN_GAP_WORD_S = 0.2


@dataclass(frozen=True)
class Alignment:
    lines: list[list[AsrWord]]
    matched: int
    total: int


def parse_lyrics(text: str) -> list[list[str]]:
    """One lyric line per non-empty text line; words are whitespace-separated tokens.

    Lines starting with `#` are comments. Tokens without letters or digits (dashes) are dropped.
    """
    lines = []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        tokens = [t for t in raw.split() if normalize(t)]
        if tokens:
            lines.append(tokens)
    return lines


def _weight(text: str) -> float:
    return max(2, len(normalize(text)))


def _spread(texts: list[str], start: float, end: float) -> list[tuple[float, float]]:
    """Split [start, end] between words in proportion to their letter count."""
    weights = [_weight(t) for t in texts]
    total = sum(weights)
    out, t = [], start
    for w in weights:
        step = (end - start) * w / total
        out.append((t, t + step))
        t += step
    return out


def align_known(lines: list[list[str]], asr: list[AsrWord], start_s: float, end_s: float) -> Alignment:
    """Time every lyric word inside [start_s, end_s]; times are strictly ordered.

    `asr` must be ordered (as `track.clean_words` returns it).
    """
    flat = [(li, text) for li, line in enumerate(lines) for text in line]
    n = len(flat)
    if n == 0:
        return Alignment(lines=[], matched=0, total=0)
    span_start = asr[0].start_s if asr else start_s
    span_end = asr[-1].end_s if asr else end_s
    if span_end - span_start < MIN_WORD_S * n:
        span_start, span_end = start_s, end_s
    guesses = _spread([t for _, t in flat], span_start, span_end)
    lyric = [LyricWord(index=i, line=li, text=text, start_s=g[0], end_s=g[1])
             for i, ((li, text), g) in enumerate(zip(flat, guesses))]
    by_onset = {w.start_s: w for w in asr}
    evidence = match_words(lyric, asr, max_shift_s=end_s - start_s + 1.0)
    anchors: dict[int, tuple[float, float]] = {}
    for e in evidence:
        if e.onset_s is not None and e.onset_s in by_onset:
            w = by_onset[e.onset_s]
            anchors[e.index] = (w.start_s, w.end_s)

    if anchors:
        lengths = [b - a for a, b in anchors.values()]
        typical = min(max(sum(lengths) / len(lengths), 0.2), 0.8)
    else:
        typical = DEFAULT_WORD_S
    times: list[tuple[float, float] | None] = [anchors.get(i) for i in range(n)]
    i = 0
    while i < n:
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < n and times[j] is None:
            j += 1
        texts = [flat[k][1] for k in range(i, j)]
        left = times[i - 1][1] if i > 0 else None
        right = times[j][0] if j < n else None
        if left is None and right is None:
            lo, hi = start_s, end_s
        elif left is None:
            lo, hi = max(start_s, right - typical * len(texts)), right
        elif right is None:
            lo, hi = left, min(end_s, left + typical * len(texts))
        else:
            lo, hi = left, right
            if hi - lo < MIN_GAP_WORD_S * len(texts):
                # Re-spread the left anchor and the missing words from the anchor's start.
                start = times[i - 1][0]
                spans = _spread([flat[i - 1][1]] + texts, start, right)
                times[i - 1] = spans[0]
                for k, span in zip(range(i, j), spans[1:]):
                    times[k] = span
                i = j
                continue
        if hi - lo < MIN_WORD_S * len(texts):
            hi = lo + MIN_WORD_S * len(texts)
        for k, span in zip(range(i, j), _spread(texts, lo, hi)):
            times[k] = span
        i = j

    # Strictly ordered and inside the clip, even after squeezing short gaps.
    out_lines: list[list[AsrWord]] = [[] for _ in lines]
    previous = start_s
    for k, ((li, text), (a, b)) in enumerate(zip(flat, times)):
        remaining = n - k
        latest = end_s - MIN_WORD_S * remaining
        a = min(max(a, previous), latest)
        b = min(max(b, a + MIN_WORD_S), end_s - MIN_WORD_S * (remaining - 1))
        out_lines[li].append(AsrWord(text=text, start_s=round(a, 3), end_s=round(b, 3)))
        previous = b
    return Alignment(lines=out_lines, matched=len(anchors), total=n)
