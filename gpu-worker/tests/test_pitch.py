import numpy as np
import pytest

from perepev_worker.pitch import hz_to_midi

SR = 16000


def test_hz_to_midi():
    assert hz_to_midi(440.0) == pytest.approx(69.0)
    assert hz_to_midi(220.0) == pytest.approx(57.0)


@pytest.mark.models
def test_f0_sine():
    from perepev_worker.pitch import f0_frames

    t = np.arange(SR * 2) / SR
    frames = f0_frames(0.5 * np.sin(2 * np.pi * 220 * t), SR)
    assert len(frames) == 200
    assert frames[0][0] == 0.0 and frames[1][0] == pytest.approx(0.01)
    voiced = [m for _, m in frames if m is not None]
    assert len(voiced) > 150
    assert abs(float(np.median(voiced)) - 57.0) <= 0.3


@pytest.mark.models
def test_f0_silence_and_noise_are_unvoiced():
    from perepev_worker.pitch import f0_frames

    rng = np.random.default_rng(0)
    frames = f0_frames(np.concatenate([np.zeros(SR), rng.standard_normal(SR) * 0.1]), SR)
    voiced = sum(m is not None for _, m in frames)
    assert voiced < len(frames) * 0.1
