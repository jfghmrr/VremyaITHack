"""Sung-word recognition (openai-whisper) and fuzzy monotonic matching against known lyrics."""
from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass

import numpy as np
from rapidfuzz import fuzz

from .audio import resample, rms
from .profanity import mask

MIN_RATIO = 70.0
# A lyric word only matches recognised words within this many seconds of its reference time.
MAX_SHIFT_S = 3.0
# Below this RMS (about -60 dBFS) the take is silence: whisper would only hallucinate.
SILENCE_RMS = 1e-3

_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)


@dataclass(frozen=True)
class LyricWord:
    index: int
    line: int
    text: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class AsrWord:
    text: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class WordEvidence:
    index: int
    sung: float
    onset_s: float | None

    def as_json(self) -> dict:
        return {"index": self.index, "sung": round(self.sung, 3),
                "onset_s": None if self.onset_s is None else round(self.onset_s, 3)}


def normalize(text: str) -> str:
    """Lower-case, ё→е, letters and digits only (Russian and English)."""
    return _NON_WORD.sub("", text.lower().replace("ё", "е"))


def match_words(lyric: list[LyricWord], asr: list[AsrWord], max_shift_s: float = MAX_SHIFT_S) -> list[WordEvidence]:
    """Monotonic alignment maximising fuzzy similarity; one recognised word per lyric word.

    A pair counts when rapidfuzz ratio >= 70 and the times are within `max_shift_s`;
    sung = ratio / 100 and the onset comes from the recognised word. A tiny time
    penalty breaks ties between repeated words (choruses) in favour of the nearest.
    A masked lyric word ("б****", own-track lyrics) is compared with the masked
    recognised word, so singing the real word still counts.
    """
    a = [normalize(w.text) for w in lyric]
    plain = [normalize(w.text) for w in asr]
    masked = [normalize(mask(w.text)[0]) for w in asr] if any("*" in w.text for w in lyric) else plain
    n, m = len(a), len(plain)
    gain = np.zeros((n, m))
    ratio = np.zeros((n, m))
    for i in range(n):
        b = masked if "*" in lyric[i].text else plain
        for j in range(m):
            if not a[i] or not b[j] or abs(asr[j].start_s - lyric[i].start_s) > max_shift_s:
                continue
            r = fuzz.ratio(a[i], b[j])
            if r >= MIN_RATIO:
                ratio[i, j] = r
                gain[i, j] = r / 100 - 0.001 * abs(asr[j].start_s - lyric[i].start_s)
    best = np.zeros((n + 1, m + 1))
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            take = best[i - 1, j - 1] + gain[i - 1, j - 1] if ratio[i - 1, j - 1] else -1.0
            best[i, j] = max(best[i - 1, j], best[i, j - 1], take)
    evidence = {w.index: WordEvidence(w.index, 0.0, None) for w in lyric}
    i, j = n, m
    while i > 0 and j > 0:
        if ratio[i - 1, j - 1] and best[i, j] == best[i - 1, j - 1] + gain[i - 1, j - 1]:
            w = lyric[i - 1]
            evidence[w.index] = WordEvidence(w.index, ratio[i - 1, j - 1] / 100, asr[j - 1].start_s)
            i, j = i - 1, j - 1
        elif best[i, j] == best[i - 1, j]:
            i -= 1
        else:
            j -= 1
    return [evidence[w.index] for w in lyric]


_model = None
_model_name = ""
_lock = threading.Lock()


def asr_model_name() -> str:
    """PEREPEV_ASR_MODEL overrides; `large-v3-turbo` on CUDA, `small` on CPU."""
    from .runtime import device

    return os.environ.get("PEREPEV_ASR_MODEL") or ("large-v3-turbo" if device() == "cuda" else "small")


def load_model():
    """Load (and download on first use) the whisper model once per process."""
    global _model, _model_name
    if _model is None:
        import whisper

        from .runtime import device, models_dir

        name = asr_model_name()
        _model = whisper.load_model(name, device=device(), download_root=str(models_dir() / "whisper"))
        _model_name = name
    return _model


def transcribe(y: np.ndarray, sr: int, language: str, beam_size: int | None = None,
               prompt: str | None = None) -> list[AsrWord]:
    """Recognise sung words with word timestamps.

    Scoring passes no lyric prompt, so it cannot echo the lyrics. `catalog import` may pass
    the known lyrics as `prompt` (spelling hint only: the result is still matched to the lyrics).
    Decoding is deterministic (temperature 0); `beam_size=5` is slower but recovers more
    sung words (used for own tracks, and for scoring on CUDA).
    """
    audio = resample(np.asarray(y, dtype=np.float32), sr, 16000)
    if rms(audio) < SILENCE_RMS:
        return []
    with _lock:
        model = load_model()
        result = model.transcribe(
            audio, language=language, task="transcribe", word_timestamps=True, temperature=0.0,
            beam_size=beam_size, condition_on_previous_text=False, fp16=model.device.type == "cuda", verbose=None,
            initial_prompt=prompt,
        )
    words = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            text = w["word"].strip()
            if normalize(text):
                words.append(AsrWord(text=text, start_s=float(w["start"]), end_s=float(w["end"])))
    return words
