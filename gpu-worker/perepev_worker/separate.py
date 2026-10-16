"""Vocal / instrumental separation with Demucs 4 `htdemucs` (MIT code and weights)."""
from __future__ import annotations

import threading

import numpy as np

from .audio import resample

MODEL_NAME = "htdemucs"
_model = None
_device = "cpu"
_lock = threading.Lock()


def load_model():
    """Load (downloading on first use) the separation model once per process."""
    global _model, _device
    if _model is None:
        from demucs.pretrained import get_model

        from .runtime import device, models_dir

        models_dir()
        model = get_model(MODEL_NAME)
        model.eval()
        _device = device()
        _model = model
    return _model


def _apply(model, wav):
    import torch
    from demucs.apply import apply_model

    # split=True processes ~8 s segments, which keeps memory flat for any clip length.
    with torch.inference_mode():
        return apply_model(model, wav[None], device=_device, shifts=0, split=True, overlap=0.25, progress=False)[0]


def separate(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Split a mix into (vocals, instrumental) with the input's shape and sample rate.

    `y` is (n,) mono or (n, channels). The instrumental is drums + bass + other.
    """
    import torch

    y = np.asarray(y, dtype=np.float32)
    mono = y.ndim == 1
    x = y[:, None] if mono else y
    if x.shape[1] not in (1, 2):
        raise ValueError("separate() takes mono or stereo audio")
    with _lock:
        model = load_model()
        x = resample(x, sr, model.samplerate)
        x = np.repeat(x, 2, axis=1) if x.shape[1] == 1 else x
        wav = torch.from_numpy(np.ascontiguousarray(x.T))
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        sources = _apply(model, (wav - mean) / std).cpu() * std + mean
    vocal_index = model.sources.index("vocals")
    vocals = sources[vocal_index].numpy().T
    instrumental = (sources.sum(0) - sources[vocal_index]).numpy().T
    out = []
    for stem in (vocals, instrumental):
        stem = resample(np.ascontiguousarray(stem), model.samplerate, sr)
        if mono:
            stem = stem.mean(axis=1)
        elif y.shape[1] == 1:
            stem = stem.mean(axis=1, keepdims=True)
        stem = stem[: len(y)]
        if len(stem) < len(y):
            stem = np.pad(stem, [(0, len(y) - len(stem))] + [(0, 0)] * (stem.ndim - 1))
        out.append(np.ascontiguousarray(stem, dtype=np.float32))
    return out[0], out[1]
