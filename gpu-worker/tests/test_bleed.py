import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

from perepev_worker.bleed import bleed

SR = 16000
GUIDE_GAIN = 10 ** (-15 / 20)  # the client plays the guide vocal about 15 dB under the instrumental


def melody(seed, seconds, jitter_s=0.0, voice=0):
    """A sung-like line: notes, syllables, vibrato, eight harmonics and some breath.

    The same `seed` gives the same notes and syllables; `voice` changes everything a
    different person would: phase, vibrato, slight detuning, breath noise.
    """
    song = np.random.default_rng(seed)
    person = np.random.default_rng(1000 * seed + voice)
    n = SR * seconds
    t = np.arange(n)
    notes = song.integers(55, 67, seconds * 3)
    syllables = (song.uniform(size=seconds * 6) > 0.25).astype(float)
    detune = person.uniform(-0.15, 0.15, len(notes))
    midi = (notes + detune)[t * len(notes) // n]
    midi = midi + 0.4 * np.sin(2 * np.pi * person.uniform(5, 6.5) * t / SR + person.uniform(0, 6.28))
    gate = syllables[t * len(syllables) // n]
    if jitter_s:
        gate = np.roll(gate, int(jitter_s * SR))
    gate = np.convolve(gate, np.ones(400) / 400, "same")
    phase = 2 * np.pi * np.cumsum(440 * 2 ** ((midi - 69) / 12)) / SR + person.uniform(0, 2 * np.pi)
    tone = sum(np.sin(h * phase) / h for h in range(1, 9))
    breath = sosfilt(butter(2, [1500, 5000], btype="band", fs=SR, output="sos"), person.standard_normal(n))
    return 0.3 * gate * (tone + 0.3 * breath)


def speaker_room(x, rng, latency_s=0.2, rt60=0.4):
    y = sosfilt(butter(4, [300, 7000], btype="band", fs=SR, output="sos"), x)
    t = np.arange(int(rt60 * SR)) / SR
    ir = rng.standard_normal(len(t)) * np.exp(-6.9 * t / rt60) * 0.3
    ir[0] = 1.0
    y = fftconvolve(y, ir)[: len(x)]
    return np.concatenate([np.zeros(int(latency_s * SR)), y])[: len(x)]


def test_bleed_detects_copy():
    rng = np.random.default_rng(1)
    stem = rng.standard_normal(SR * 12) * np.repeat(rng.uniform(0, 1, 12 * 20), SR // 20)
    delay = int(0.18 * SR)
    recording = np.concatenate([np.zeros(delay), stem[:-delay]]) * 0.5 + rng.standard_normal(len(stem)) * 0.05
    assert bleed(recording, stem, SR) > 0.8
    assert bleed(rng.standard_normal(len(stem)), stem, SR) < 0.2


def test_bleed_of_silence_is_zero():
    rng = np.random.default_rng(2)
    stem = rng.standard_normal(SR * 5)
    assert bleed(np.zeros(SR * 5), stem, SR) == 0.0
    assert bleed(stem, np.zeros(SR * 5), SR) == 0.0


def test_singing_along_is_not_bleed():
    # A singer follows the same notes and phrases (so loudness envelopes match closely),
    # but a human voice is never a waveform copy of the guide.
    rng = np.random.default_rng(3)
    guide = melody(7, 20)
    singer = melody(7, 20, jitter_s=0.03, voice=1) * 0.8
    singer = np.roll(singer, int(0.12 * SR)) + rng.standard_normal(len(singer)) * 1e-3
    assert bleed(singer, guide, SR) < 0.2


def test_quiet_guide_from_phone_speaker_is_detected():
    # Silent user, headphones mix playing on the phone speaker: the guide is 15 dB under the instrumental.
    rng = np.random.default_rng(4)
    guide = melody(8, 20)
    instrumental = rng.standard_normal(SR * 20) * np.repeat(rng.uniform(0.05, 0.3, 20 * 8), SR // 8)
    played = instrumental + GUIDE_GAIN * guide
    recording = speaker_room(played, rng) + rng.standard_normal(len(played)) * 1e-3
    assert bleed(recording, guide, SR, other=instrumental) >= 0.45
    assert bleed(recording, instrumental, SR, other=guide) > 0.8


def test_instrumental_with_vocal_residue_is_not_guide_bleed():
    # "Без наушников" mode plays only the instrumental; separation leaves some vocal in it.
    rng = np.random.default_rng(5)
    guide = melody(9, 20)
    instrumental = rng.standard_normal(SR * 20) * np.repeat(rng.uniform(0.05, 0.3, 20 * 8), SR // 8) + 0.3 * guide
    recording = speaker_room(instrumental, rng) + rng.standard_normal(len(guide)) * 1e-3
    assert bleed(recording, guide, SR, other=instrumental) < 0.45
    assert bleed(recording, instrumental, SR, other=guide) > 0.8
