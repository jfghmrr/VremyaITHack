"""Melody (F0) with torchcrepe `full` (MIT): 10 ms hop, 65-1100 Hz, periodicity >= 0.5, 5-frame median."""
from __future__ import annotations

import math
import threading

import numpy as np

from .audio import resample

SR = 16000
HOP = 160  # 10 ms
FMIN, FMAX = 65.0, 1100.0
PERIODICITY = 0.5
MEDIAN = 5
SILENCE_RMS = 1e-3  # about -60 dBFS over a 64 ms window
MODEL = "full"
# Frames per torchcrepe batch. On the CPU `full` needs about 35 MB per frame (the second
# convolution's im2col), so 32 frames peak near 2 GB RSS; 256 frames reached 5.4 GB.
BATCH = {"cuda": 128, "cpu": 32}
_lock = threading.Lock()


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def frame_rms(audio: np.ndarray, n: int, window: int = 1024) -> np.ndarray:
    padded = np.pad(audio.astype(np.float64), window // 2)
    power = np.concatenate([[0.0], np.cumsum(padded ** 2)])
    starts = np.arange(n) * HOP
    return np.sqrt((power[starts + window] - power[starts]) / window)


def f0_frames(y: np.ndarray, sr: int) -> list[tuple[float, float | None]]:
    """Return (t, midi | None) every 10 ms from t = 0, one frame per started hop."""
    import torch
    import torchcrepe

    from .runtime import device

    y = np.asarray(y, dtype=np.float32)
    audio = resample(y.mean(axis=1) if y.ndim == 2 else y, sr, SR)
    n = math.ceil(len(audio) / HOP)
    if n == 0:
        return []
    dev = device()
    with _lock:
        pitch, periodicity = torchcrepe.predict(
            torch.from_numpy(np.ascontiguousarray(audio))[None], SR, hop_length=HOP, fmin=FMIN, fmax=FMAX,
            model=MODEL, decoder=torchcrepe.decode.viterbi, return_periodicity=True,
            batch_size=BATCH[dev], device=dev, pad=True,
        )
    periodicity = torchcrepe.filter.median(periodicity, MEDIAN)[0, :n].cpu().numpy()
    pitch = torchcrepe.filter.median(pitch, MEDIAN)[0, :n].cpu().numpy()
    voiced = (periodicity >= PERIODICITY) & (frame_rms(audio, len(pitch)) >= SILENCE_RMS) & (pitch > 0)
    frames = []
    for i in range(n):
        midi = round(hz_to_midi(float(pitch[i])), 2) if i < len(pitch) and voiced[i] else None
        frames.append((round(i * HOP / SR, 2), midi))
    return frames
