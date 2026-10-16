"""Speaker-bleed check: is a delayed, filtered copy of a played stem present in the recording?

Measure: Welch-averaged cross-spectrum with PHAT weighting (GCC-PHAT) over 200-4000 Hz,
lags within +-0.5 s. Its peak is expressed as a z-score against the correlation's own
noise floor and mapped to 0..1 (Z_LOW -> 0, Z_HIGH -> 1).

Why not loudness envelopes: someone singing along follows the same phrases, so 50 ms RMS
envelopes of a real singer correlated 0.63-0.74 with the guide in our simulation, above
the 0.45 cap threshold. A voice is never a waveform copy of the guide, while speaker
bleed is, even when the guide is 15 dB under the instrumental. With `other` (the other
played stem) its contribution is projected out first, so vocal residue inside the
instrumental does not count as guide bleed.
"""
from __future__ import annotations

import numpy as np

from .audio import rms

MAX_LAG_S = 0.5
BAND_HZ = (200.0, 4000.0)
Z_LOW, Z_HIGH = 9.0, 17.0


def _segments(x: np.ndarray, nfft: int) -> np.ndarray:
    hop = nfft // 2
    if len(x) < nfft:
        x = np.pad(x, (0, nfft - len(x)))
    window = np.hanning(nfft)
    starts = range(0, len(x) - nfft + 1, hop)
    return np.array([np.fft.rfft(x[s:s + nfft] * window) for s in starts])


def bleed(rec: np.ndarray, stem: np.ndarray, sr: int, other: np.ndarray | None = None) -> float:
    """0..1 strength of `stem` (optionally excluding what `other` explains) inside `rec`."""
    n = min(len(rec), len(stem), len(other) if other is not None else len(stem))
    rec = np.asarray(rec[:n], dtype=np.float64)
    stem = np.asarray(stem[:n], dtype=np.float64)
    if n == 0 or rms(rec) < 1e-5 or rms(stem) < 1e-5:
        return 0.0
    nfft = 1 << int(np.ceil(np.log2(2 * sr)))  # about 2 s: room for the lag plus reverb
    r_spec, s_spec = _segments(rec, nfft), _segments(stem, nfft)
    if other is not None and rms(other[:n]) >= 1e-5:
        o_spec = _segments(np.asarray(other[:n], dtype=np.float64), nfft)
        beta = (s_spec * np.conj(o_spec)).sum(0) / ((np.abs(o_spec) ** 2).sum(0) + 1e-12)
        s_spec = s_spec - beta * o_spec
    cross = (r_spec * np.conj(s_spec)).sum(0)
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    band = (freqs >= BAND_HZ[0]) & (freqs <= BAND_HZ[1])
    weighted = np.zeros_like(cross)
    weighted[band] = cross[band] / (np.abs(cross[band]) + 1e-12)
    corr = np.fft.irfft(weighted, nfft)
    lag = min(int(MAX_LAG_S * sr), nfft // 2 - 1)
    corr = np.abs(np.concatenate([corr[-lag:], corr[: lag + 1]]))
    floor = 1.4826 * np.median(corr)
    if floor <= 0:
        return 0.0
    z = corr.max() / floor
    return round(float(np.clip((z - Z_LOW) / (Z_HIGH - Z_LOW), 0.0, 1.0)), 3)
