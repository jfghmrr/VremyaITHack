"""Score job: the singer's F0 frames, sung-word evidence and speaker bleed (C2 ScoreOutput)."""
from __future__ import annotations

from pathlib import Path

from .audio import load_audio, rms
from .bleed import bleed
from .pitch import MODEL as PITCH_MODEL, f0_frames
from .profanity import mask
from .runtime import device
from .words import SILENCE_RMS, LyricWord, asr_model_name, match_words, transcribe

SR = 16000


def _lyric_words(params: dict) -> list[LyricWord]:
    return [LyricWord(index=int(w["index"]), line=int(w.get("line", 0)), text=str(w["text"]),
                      start_s=float(w["start_s"]), end_s=float(w.get("end_s", w["start_s"])))
            for w in params.get("words") or []]


def process_score(wav_path: str | Path, params: dict, assets: dict[str, Path]) -> dict:
    """`wav_path`: 16 kHz mono take, t = 0 is song time 0. `assets`: the stems the singer heard."""
    recording = load_audio(wav_path, SR)
    models = {"pitch": f"torchcrepe-{PITCH_MODEL}", "asr": f"openai-whisper-{asr_model_name()}"}
    voice = recording
    if params.get("mode") == "speaker" and rms(recording) >= SILENCE_RMS:
        # Without headphones the instrumental reaches the microphone: keep only the voice.
        from .separate import MODEL_NAME, separate

        voice, _ = separate(recording, SR)
        models["separation"] = MODEL_NAME

    frames = f0_frames(voice, SR)
    recognised = transcribe(voice, SR, params.get("language") or "ru", beam_size=5 if device() == "cuda" else None)
    evidence = match_words(_lyric_words(params), recognised)
    asr_text, _ = mask(" ".join(w.text for w in recognised))

    stems = {name: load_audio(path, SR) for name, path in assets.items()}
    guide, instrumental = stems.get("guide.mp3"), stems.get("instrumental.mp3")
    return {
        "frames": [{"t": t, "midi": midi} for t, midi in frames],
        "words": [e.as_json() for e in evidence],
        "asr_text": asr_text,
        "bleed": {
            "instrumental": bleed(recording, instrumental, SR, other=guide) if instrumental is not None else 0.0,
            "guide": bleed(recording, guide, SR, other=instrumental) if guide is not None else 0.0,
        },
        "models": models,
    }
