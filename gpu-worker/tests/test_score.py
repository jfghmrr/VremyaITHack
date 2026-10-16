import json
import wave

import numpy as np

from perepev_worker import score as score_mod
from perepev_worker.words import AsrWord, WordEvidence

SR = 16000


def write_wav(path, y, sr=SR):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


PARAMS = {"sample_rate": 16000, "language": "ru", "duration_s": 2.0,
          "words": [{"index": 0, "line": 0, "text": "Пусть", "start_s": 0.5, "end_s": 0.8},
                    {"index": 1, "line": 0, "text": "в", "start_s": 0.8, "end_s": 0.9},
                    {"index": 2, "line": 0, "text": "блядь", "start_s": 1.0, "end_s": 1.3}],
          "assets": ["instrumental.mp3", "guide.mp3"], "mode": "headphones"}


def test_process_score_output_shape(tmp_path, monkeypatch):
    rng = np.random.default_rng(3)
    rec = rng.standard_normal(SR * 2) * np.repeat(rng.uniform(0, 0.3, 40), SR // 20)
    write_wav(tmp_path / "in.wav", rec)
    write_wav(tmp_path / "guide.wav", rec)
    monkeypatch.setattr(score_mod, "f0_frames", lambda y, sr: [(i * 0.01, 57.0 if i % 2 else None) for i in range(200)])
    monkeypatch.setattr(score_mod, "transcribe", lambda y, sr, language, beam_size=None: [AsrWord("пусть", 0.52, 0.8), AsrWord("блядь", 1.0, 1.3)])
    out = score_mod.process_score(tmp_path / "in.wav", PARAMS, {"guide.mp3": tmp_path / "guide.wav"})
    json.dumps(out, allow_nan=False)
    assert set(out) == {"frames", "words", "asr_text", "bleed", "models"}
    assert len(out["frames"]) == 200
    assert out["frames"][0] == {"t": 0.0, "midi": None} and out["frames"][1] == {"t": 0.01, "midi": 57.0}
    assert out["words"] == [{"index": 0, "sung": 1.0, "onset_s": 0.52},
                            {"index": 1, "sung": 0.0, "onset_s": None},
                            {"index": 2, "sung": 1.0, "onset_s": 1.0}]
    assert out["asr_text"] == "пусть б****"
    assert out["bleed"]["instrumental"] == 0.0
    assert out["bleed"]["guide"] > 0.8
    assert out["models"]["pitch"] == "torchcrepe-full" and out["models"]["asr"].startswith("openai-whisper-")
