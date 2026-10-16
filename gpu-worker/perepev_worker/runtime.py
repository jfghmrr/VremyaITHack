"""Device choice and the local model cache shared by all pipelines."""
from __future__ import annotations

import os
from pathlib import Path

# demucs 4.1 resolves `htdemucs` through the HuggingFace hub repository adefossez/HTDemucs.
HTDEMUCS_REPO = "models--adefossez--HTDemucs"
HTDEMUCS_BAG = "htdemucs.yaml"


def htdemucs_cached(hf_home: Path) -> bool:
    """True when the hub cache holds the htdemucs bag: its yaml and every model file it lists."""
    repo = Path(hf_home) / "hub" / HTDEMUCS_REPO
    try:
        import yaml  # a demucs dependency

        commit = (repo / "refs" / "main").read_text(encoding="utf-8").strip()
        snapshot = repo / "snapshots" / commit
        bag = yaml.safe_load((snapshot / HTDEMUCS_BAG).read_text(encoding="utf-8"))
        signatures = bag["models"]
    except Exception:  # missing, partial or unreadable cache: download as on the first start
        return False
    return bool(signatures) and all((snapshot / f"{sig}.safetensors").is_file() for sig in signatures)


def models_dir() -> Path:
    """Model downloads go to PEREPEV_MODELS_DIR (default ~/.cache/perepev-worker).

    Once htdemucs is in the hub cache, HF_HUB_OFFLINE=1: a start then never contacts huggingface.co
    (online, every start asked the hub for updates, and a blocked connection cost 2 x 10 s before
    the hub fell back to the cache). Whisper and torchcrepe already load from local files. An
    explicit HF_HUB_OFFLINE in the environment wins. huggingface_hub reads the variable once, when
    it is imported, so this runs before any model is loaded (warmup() calls it first; the worker
    modules do not import the hub at import time).
    """
    path = Path(os.environ.get("PEREPEV_MODELS_DIR") or Path.home() / ".cache" / "perepev-worker")
    path.mkdir(parents=True, exist_ok=True)
    hf_home = Path(os.environ.setdefault("HF_HOME", str(path / "huggingface")))
    # demucs falls back to the legacy torch.hub download when the hub has no htdemucs.
    os.environ.setdefault("TORCH_HOME", str(path / "torch"))
    if "HF_HUB_OFFLINE" not in os.environ and htdemucs_cached(hf_home):
        os.environ["HF_HUB_OFFLINE"] = "1"
    return path


def device() -> str:
    """CUDA when available (the Windows GPU PC), otherwise CPU.

    Apple MPS is never used: Demucs on MPS reached 23 GB RSS on a 16 GB Mac and caused a
    kernel panic (2026-10-16). PEREPEV_DEVICE=cpu forces the CPU on a CUDA machine.
    """
    import torch

    if os.environ.get("PEREPEV_DEVICE") == "cpu":
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"
