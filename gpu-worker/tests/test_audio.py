import io
import wave

import numpy as np
import pytest

from perepev_worker.audio import load_audio, mp3_bytes, resample, write_mp3


def write_wav(path, y, sr):
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def test_load_wav_resamples_to_requested_rate(tmp_path):
    t = np.arange(44100 * 2) / 44100
    write_wav(tmp_path / "a.wav", 0.5 * np.sin(2 * np.pi * 440 * t), 44100)
    y = load_audio(tmp_path / "a.wav", 16000)
    assert y.dtype == np.float32 and y.ndim == 1
    assert abs(len(y) - 32000) <= 1
    spectrum = np.abs(np.fft.rfft(y))
    assert abs(np.argmax(spectrum) * 16000 / len(y) - 440) < 2


def test_write_mp3_roundtrip_keeps_length_and_rate(tmp_path):
    sr = 44100
    t = np.arange(sr * 3) / sr
    stereo = np.stack([np.sin(2 * np.pi * 220 * t), np.sin(2 * np.pi * 330 * t)], axis=1) * 0.3
    path = tmp_path / "x.mp3"
    write_mp3(path, stereo, sr)
    data = path.read_bytes()
    assert data[:3] == b"ID3" or (data[0] == 0xFF and data[1] & 0xE0 == 0xE0)
    kbps = len(data) * 8 / 3 / 1000
    assert 140 < kbps < 180
    back = load_audio(path, sr, mono=False)
    assert back.shape == (sr * 3, 2)
    assert np.corrcoef(back[2000:-2000, 0], stereo[2000:-2000, 0])[0, 1] > 0.99


def test_mp3_bytes_from_16k_mono_is_44k_mp3(tmp_path):
    y = np.sin(2 * np.pi * 300 * np.arange(16000) / 16000).astype(np.float32) * 0.2
    data = mp3_bytes(y, 16000)
    (tmp_path / "y.mp3").write_bytes(data)
    import soundfile as sf
    info = sf.info(str(tmp_path / "y.mp3"))
    assert info.samplerate == 44100
    assert abs(info.frames - 44100) <= 1


def test_resample_identity_and_length():
    y = np.random.default_rng(0).standard_normal(1000).astype(np.float32)
    assert resample(y, 16000, 16000) is y
    assert len(resample(y, 16000, 44100)) == 2757  # ceil(1000 * 44100 / 16000)


def test_load_audio_rejects_non_audio(tmp_path):
    (tmp_path / "x.wav").write_text("not audio")
    with pytest.raises(ValueError):
        load_audio(tmp_path / "x.wav", 16000)
