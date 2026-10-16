"""Audio I/O without ffmpeg: libsndfile (via soundfile) decodes WAV/FLAC/OGG/MP3 and encodes MP3."""
from __future__ import annotations

import io
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

MP3_RATE = 44100
# libsndfile maps compression 0..1 onto LAME bitrates; 0.5 gives 160 kbps CBR at 44.1 kHz.
MP3_COMPRESSION = 0.5


def resample(y: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    """Polyphase resampling along the first axis; returns `y` itself when the rates match."""
    if sr_from == sr_to:
        return y
    g = gcd(int(sr_from), int(sr_to))
    return resample_poly(y, sr_to // g, sr_from // g, axis=0).astype(np.float32)


def load_audio(path: str | Path, sr: int, mono: bool = True) -> np.ndarray:
    """Decode a file to float32 at `sr`: shape (n,) when mono, else (n, channels)."""
    try:
        y, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError) as err:
        raise ValueError(f"cannot decode audio: {Path(path).name}") from err
    if mono:
        y = y.mean(axis=1)
    return np.ascontiguousarray(resample(y, file_sr, sr), dtype=np.float32)


def _encode(target, y: np.ndarray, sr: int) -> None:
    y = resample(np.asarray(y, dtype=np.float32), sr, MP3_RATE)
    channels = 1 if y.ndim == 1 else y.shape[1]
    with sf.SoundFile(target, "w", MP3_RATE, channels, format="MP3", subtype="MPEG_LAYER_III",
                      compression_level=MP3_COMPRESSION, bitrate_mode="CONSTANT") as f:
        f.write(np.clip(y, -1.0, 1.0))


def write_mp3(path: str | Path, y: np.ndarray, sr: int) -> None:
    """Write ~160 kbps CBR MP3 at 44.1 kHz with a LAME/Info tag (gapless, same length as `y`)."""
    tmp = Path(path).with_suffix(".tmp.mp3")
    _encode(str(tmp), y, sr)
    tmp.replace(path)


def mp3_bytes(y: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    buf.name = "audio.mp3"
    _encode(buf, y, sr)
    return buf.getvalue()


def rms(y: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))) if len(y) else 0.0
