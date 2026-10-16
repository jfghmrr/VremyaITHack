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
from .words import AsrWord, normalize

SR = 44100
HOP_S = 0.01
MAX_GAP_S = 0.6
MAX_LINE_WORDS = 8
MAX_DURATION_S = 60.0
MIN_DURATION_S = 5.0
MIN_WORD_S = 0.01
# Reference melody only where the separated vocal is within 30 dB of its loud parts:
# quiet separation residue would otherwise become "melody" nobody sings.
VOCAL_GATE_DB = -30.0
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


def group_lines(words: list[AsrWord], max_gap_s: float = MAX_GAP_S, max_words: int = MAX_LINE_WORDS) -> list[list[AsrWord]]:
    """A new line starts after a pause longer than 0.6 s or when a line has 8 words."""
    lines: list[list[AsrWord]] = []
    for w in words:
        if lines and len(lines[-1]) < max_words and w.start_s - lines[-1][-1].end_s <= max_gap_s:
            lines[-1].append(w)
        else:
            lines.append([w])
    return lines


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


def _gate_quiet(frames, vocals: np.ndarray, sr: int):
    from .pitch import SR as PITCH_SR, frame_rms

    audio = resample(vocals, sr, PITCH_SR)
    level = frame_rms(audio, len(frames))
    loud = np.percentile(level, 95) if len(level) else 0.0
    threshold = loud * 10 ** (VOCAL_GATE_DB / 20)
    return [(t, m if i < len(level) and level[i] >= threshold else None) for i, (t, m) in enumerate(frames)]


def _json_bytes(data: dict) -> bytes:
    return (json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()


def process_track(wav_path: str | Path, language: str, title: str, *, margin_s: float = 2.0,
                  song_id: str = "my-track", progress: Callable[[str], None] | None = None) -> TrackResult:
    """Turn an uploaded section (plus margins) into karaoke files for a private song."""
    from .pitch import MODEL as PITCH_MODEL, f0_frames
    from .separate import MODEL_NAME, separate
    from .words import asr_model_name, transcribe

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
    frames = _gate_quiet(f0_frames(vocal_mono, SR), vocal_mono, SR)

    report("words")
    masked_words = 0
    words = []
    for w in clean_words(transcribe(vocal_mono, SR, language, beam_size=5), duration_s):
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
        "models": {"separation": MODEL_NAME, "pitch": f"torchcrepe-{PITCH_MODEL}", "asr": f"openai-whisper-{asr_model_name()}"},
    }
    return TrackResult(files=files, output=output)
