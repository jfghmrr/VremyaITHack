"""Own-track pipeline: section with margins -> stems, melody, recognised lyrics, song files."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import load_audio, mp3_bytes, resample
from .profanity import mask
from .words import AsrWord, keep_sung, normalize

SR = 44100
HOP_S = 0.01
MAX_GAP_S = 0.6
MAX_LINE_WORDS = 8
# A karaoke line longer than this is split at its widest pause.
MAX_LINE_S = 7.0
MAX_DURATION_S = 60.0
MIN_DURATION_S = 5.0
MIN_WORD_S = 0.01
# Reference melody only where the separated vocal is within 30 dB of its loud parts:
# quiet separation residue would otherwise become "melody" nobody sings.
VOCAL_GATE_DB = -30.0
# Word timing: whisper's word timestamps on sung audio often include the silence before a
# phrase or after its last word. The separated vocal shows where somebody actually sings.
ACTIVITY_GATE_DB = -35.0
ACTIVITY_FLOOR = 1e-3  # about -60 dBFS, as words.SILENCE_RMS
CLOSE_GAP_S = 0.15  # gaps between syllables stay "singing"
MIN_BLIP_S = 0.05  # shorter bursts are clicks or bleed
TRIM_MIN_S = 0.15  # only trim silence at least this long
TRIM_PAD_S = 0.05
SILENT_REACH_S = 1.0  # a word this far from any singing is a hallucination
ARTIST = "Свой трек"


@dataclass
class TrackResult:
    files: dict[str, bytes]
    output: dict = field(default_factory=dict)


def clean_words(raw: list[AsrWord], duration_s: float) -> list[AsrWord]:
    """Strip text, drop empty tokens, make times strictly ordered and inside the song."""
    words: list[AsrWord] = []
    previous = 0.0
    for w in raw:
        text = w.text.strip()
        if not normalize(text):
            continue
        start = max(w.start_s, previous, 0.0)
        end = min(max(w.end_s, start + MIN_WORD_S), duration_s)
        if end - start < MIN_WORD_S - 1e-9:
            continue
        words.append(AsrWord(text=text, start_s=start, end_s=end))
        previous = end
    return words


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Half-open [start, end) index ranges where `mask` is True."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def vocal_activity(level: np.ndarray, hop: float = HOP_S) -> np.ndarray:
    """Where the separated vocal sings, per 10 ms frame of its RMS level.

    Within 35 dB of the loud parts and above about -60 dBFS; gaps shorter than 0.15 s are
    closed (syllables, consonants), bursts shorter than 0.05 s are dropped.
    """
    level = np.asarray(level, dtype=np.float64)
    if not len(level):
        return np.zeros(0, dtype=bool)
    threshold = max(float(np.percentile(level, 95)) * 10 ** (ACTIVITY_GATE_DB / 20), ACTIVITY_FLOOR)
    active = level >= threshold
    runs = _runs(active)
    for (_, end), (start, _) in zip(runs, runs[1:]):
        if (start - end) * hop < CLOSE_GAP_S:
            active[end:start] = True
    for start, end in _runs(active):
        if (end - start) * hop < MIN_BLIP_S:
            active[start:end] = False
    return active


def _frames(word: AsrWord, n: int, hop: float) -> tuple[int, int]:
    return max(0, math.floor(word.start_s / hop + 1e-6)), min(n, math.ceil(word.end_s / hop - 1e-6))


def refine_word_times(words: list[AsrWord], active: np.ndarray, hop: float = HOP_S) -> list[AsrWord]:
    """Trim silence (at least 0.15 s) at the start or end of each word; never extend a word."""
    out = []
    for w in words:
        i0, i1 = _frames(w, len(active), hop)
        inside = np.flatnonzero(active[i0:i1]) + i0 if i1 > i0 else np.zeros(0, dtype=int)
        if not len(inside):
            out.append(w)
            continue
        start, end = w.start_s, w.end_s
        if inside[0] * hop - start >= TRIM_MIN_S:
            start = max(start, inside[0] * hop - TRIM_PAD_S)
        if end - (inside[-1] + 1) * hop >= TRIM_MIN_S:
            end = min(end, (inside[-1] + 1) * hop + TRIM_PAD_S)
        out.append(AsrWord(text=w.text, start_s=round(start, 3), end_s=round(end, 3)))
    return out


def drop_silent_words(words: list[AsrWord], active: np.ndarray, hop: float = HOP_S,
                      reach_s: float = SILENT_REACH_S) -> list[AsrWord]:
    """Drop words with no singing within `reach_s` of them (whisper hallucinating on music).

    Without any detected singing nothing is dropped: the gate, not the words, is then wrong.
    """
    voiced = np.flatnonzero(active)
    if not len(voiced):
        return words
    reach = round(reach_s / hop)
    kept = []
    for w in words:
        i0, i1 = _frames(w, len(active), hop)
        lo, hi = np.searchsorted(voiced, [i0 - reach, i1 + reach])
        if hi > lo:
            kept.append(w)
    return kept


def _split(line: list[AsrWord], max_words: int, max_line_s: float) -> list[list[AsrWord]]:
    """Split a too long line at its widest pause (on a tie, nearest the middle)."""
    if len(line) < 2 or (len(line) <= max_words and line[-1].end_s - line[0].start_s <= max_line_s):
        return [line]
    k = max(range(1, len(line)), key=lambda i: (round(line[i].start_s - line[i - 1].end_s, 3), -abs(i - len(line) / 2)))
    return _split(line[:k], max_words, max_line_s) + _split(line[k:], max_words, max_line_s)


def group_lines(words: list[AsrWord], max_gap_s: float = MAX_GAP_S, max_words: int = MAX_LINE_WORDS,
                max_line_s: float = MAX_LINE_S) -> list[list[AsrWord]]:
    """A new line starts after a pause longer than 0.6 s. A line with more than 8 words or
    longer than 7 s is split at its widest pause rather than after a fixed word count."""
    lines: list[list[AsrWord]] = []
    for w in words:
        if lines and w.start_s - lines[-1][-1].end_s <= max_gap_s:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [part for line in lines for part in _split(line, max_words, max_line_s)]


def _r(x: float) -> float:
    return round(float(x), 3)


def build_reference(song_id: str, title: str, duration_s: float, frames, lines: list[list[AsrWord]],
                    artist: str = ARTIST) -> dict:
    """reference.json in the catalog format: 10 ms F0 grid, phrases and lyric lines."""
    n = math.ceil(round(duration_s / HOP_S, 6))
    f0: list[float | None] = [None] * n
    for t, midi in frames:
        i = round(t / HOP_S)
        if midi is not None and 0 <= i < n:
            f0[i] = round(float(midi), 3)
    return {
        "id": song_id,
        "title": title,
        "artist": artist,
        "hop_ms": 10,
        "duration_s": duration_s,
        "f0_midi": f0,
        "backing": "backing.mp3",
        "phrases": [{"start_s": _r(line[0].start_s), "end_s": _r(line[-1].end_s)} for line in lines],
        "lyrics": [{"t": _r(line[0].start_s), "text": " ".join(w.text for w in line)} for line in lines],
    }


def build_word_timing(lines: list[list[AsrWord]]) -> dict:
    """lyrics.words.json (v1), consistent with the reference lyrics."""
    return {"v": 1, "lines": [
        {"line": i, "words": [{"text": w.text, "start_s": _r(w.start_s), "end_s": _r(w.end_s)} for w in line]}
        for i, line in enumerate(lines)
    ]}


def _fade(y: np.ndarray, sr: int) -> np.ndarray:
    y = y.copy()
    fade_in, fade_out = int(0.03 * sr), int(0.08 * sr)
    ramp = np.linspace(0.0, 1.0, fade_in)
    y[:fade_in] *= ramp if y.ndim == 1 else ramp[:, None]
    ramp = np.linspace(1.0, 0.0, fade_out)
    y[-fade_out:] *= ramp if y.ndim == 1 else ramp[:, None]
    return y


def vocal_level(vocals: np.ndarray, sr: int, n: int) -> np.ndarray:
    """RMS of the separated vocal for `n` 10 ms frames (the melody grid)."""
    from .pitch import SR as PITCH_SR, frame_rms

    return frame_rms(resample(vocals, sr, PITCH_SR), n)


def _gate_level(frames, level: np.ndarray):
    loud = np.percentile(level, 95) if len(level) else 0.0
    threshold = loud * 10 ** (VOCAL_GATE_DB / 20)
    return [(t, m if i < len(level) and level[i] >= threshold else None) for i, (t, m) in enumerate(frames)]


def _gate_quiet(frames, vocals: np.ndarray, sr: int):
    return _gate_level(frames, vocal_level(vocals, sr, len(frames)))


def _json_bytes(data: dict) -> bytes:
    return (json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()


def process_track(wav_path: str | Path, language: str, title: str, *, margin_s: float = 2.0,
                  song_id: str = "my-track", progress: Callable[[str], None] | None = None) -> TrackResult:
    """Turn an uploaded section (plus margins) into karaoke files for a private song."""
    from .pitch import MODEL as PITCH_MODEL, f0_frames
    from .separate import MODEL_NAME, separate
    from .words import asr_model_name, transcribe_segments

    report = progress or (lambda stage: None)
    mix = load_audio(wav_path, SR, mono=False)
    margin = max(0, round(margin_s * SR))
    if len(mix) - 2 * margin < MIN_DURATION_S * SR:
        raise ValueError(f"section shorter than {MIN_DURATION_S:.0f} s")

    report("separating")
    vocals, instrumental = separate(mix, SR)
    end = min(len(mix) - margin, margin + int(MAX_DURATION_S * SR))
    duration_s = round((end - margin) / SR, 2)
    end = margin + round(duration_s * SR)
    mix, vocals, instrumental = (_fade(x[margin:end], SR) for x in (mix, vocals, instrumental))
    vocal_mono = vocals.mean(axis=1)

    report("melody")
    frames = f0_frames(vocal_mono, SR)
    level = vocal_level(vocal_mono, SR, len(frames))
    frames = _gate_level(frames, level)

    report("words")
    segments = transcribe_segments(vocal_mono, SR, language, beam_size=5)
    recognised = sum(len(s.words) for s in segments)
    active = vocal_activity(level)
    timed = drop_silent_words(refine_word_times(clean_words(keep_sung(segments), duration_s), active), active)
    masked_words = 0
    words = []
    for w in timed:
        text, count = mask(w.text)
        masked_words += count
        words.append(AsrWord(text=text, start_s=w.start_s, end_s=w.end_s))
    lines = group_lines(words)

    reference = build_reference(song_id, title, duration_s, frames, lines)
    files = {
        "instrumental.mp3": mp3_bytes(instrumental, SR),
        "guide.mp3": mp3_bytes(vocals, SR),
        "backing.mp3": mp3_bytes(mix, SR),
        "reference.json": _json_bytes(reference),
        "lyrics.words.json": _json_bytes(build_word_timing(lines)),
    }
    output = {
        "duration_s": duration_s,
        "lines": len(lines),
        "words": len(words),
        "masked_words": masked_words,
        # Hallucinated segments and words far from any singing that were left out.
        "dropped_words": recognised - len(words),
        "models": {"separation": MODEL_NAME, "pitch": f"torchcrepe-{PITCH_MODEL}", "asr": f"openai-whisper-{asr_model_name()}"},
    }
    return TrackResult(files=files, output=output)
