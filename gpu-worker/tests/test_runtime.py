import torch

from perepev_worker.runtime import device


def test_device_never_uses_apple_mps(monkeypatch):
    # Demucs on MPS reached 23 GB RSS on a 16 GB Mac (kernel panic, 2026-10-16): Macs run on CPU.
    monkeypatch.delenv("PEREPEV_DEVICE", raising=False)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    assert device() == "cpu"
    monkeypatch.setenv("PEREPEV_DEVICE", "mps")
    assert device() == "cpu"


def test_device_prefers_cuda_unless_cpu_forced(monkeypatch):
    monkeypatch.delenv("PEREPEV_DEVICE", raising=False)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert device() == "cuda"
    monkeypatch.setenv("PEREPEV_DEVICE", "cpu")
    assert device() == "cpu"
