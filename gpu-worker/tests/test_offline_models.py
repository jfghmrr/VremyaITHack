"""Starting from the local model cache: no huggingface.co request once htdemucs is downloaded."""
import logging
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from perepev_worker.main import main
from perepev_worker.runtime import htdemucs_cached, models_dir

COMMIT = "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003"
WORKER_DIR = Path(__file__).resolve().parents[1]


def fake_hub_cache(models: Path, *, weights: bool = True) -> Path:
    """The hub layout demucs 4.1 leaves after downloading htdemucs (plain files instead of symlinks)."""
    repo = models / "huggingface" / "hub" / "models--adefossez--HTDemucs"
    snapshot = repo / "snapshots" / COMMIT
    snapshot.mkdir(parents=True)
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(COMMIT)
    (snapshot / "htdemucs.yaml").write_text("models: ['955717e8']\n")
    if weights:
        (snapshot / "955717e8.safetensors").write_bytes(b"weights")
    return models


HUB_VARS = ("HF_HOME", "TORCH_HOME", "HF_HUB_OFFLINE", "HF_ENDPOINT")


def isolate_hub_env(monkeypatch: pytest.MonkeyPatch, models: Path) -> Path:
    """Unset the hub variables for one test and point the worker at `models`.

    models_dir() writes os.environ directly, and delenv() of an absent key records nothing to
    undo, so setenv() comes first: the undo then puts every variable back as it was, including
    removing the ones that were absent (HF_HUB_OFFLINE=1 must not leak into later tests).
    """
    for name in HUB_VARS:
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    monkeypatch.setenv("PEREPEV_MODELS_DIR", str(models))
    return models


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    return isolate_hub_env(monkeypatch, tmp_path / "models")


def test_clean_env_restores_the_environment(monkeypatch, tmp_path):
    for name in ("HF_HOME", "TORCH_HOME", "HF_HUB_OFFLINE"):
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    monkeypatch.setenv("HF_ENDPOINT", "http://example.invalid")
    with pytest.MonkeyPatch.context() as inner:
        models = isolate_hub_env(inner, tmp_path / "models")
        assert "HF_ENDPOINT" not in os.environ
        fake_hub_cache(models)
        models_dir()
        assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert {name: os.environ.get(name) for name in HUB_VARS} == {
        "HF_HOME": None, "TORCH_HOME": None, "HF_HUB_OFFLINE": None, "HF_ENDPOINT": "http://example.invalid"}


def test_cached_htdemucs_switches_the_hub_offline(clean_env):
    fake_hub_cache(clean_env)
    models_dir()
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["HF_HOME"] == str(clean_env / "huggingface")


def test_first_start_stays_online_to_download(clean_env):
    models_dir()
    assert "HF_HUB_OFFLINE" not in os.environ


def test_missing_weights_keep_the_hub_online(clean_env):
    fake_hub_cache(clean_env, weights=False)
    assert not htdemucs_cached(clean_env / "huggingface")
    models_dir()
    assert "HF_HUB_OFFLINE" not in os.environ


def test_explicit_hub_setting_wins(clean_env, monkeypatch):
    fake_hub_cache(clean_env)
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    models_dir()
    assert os.environ["HF_HUB_OFFLINE"] == "0"


def test_unreadable_bag_counts_as_not_cached(clean_env):
    fake_hub_cache(clean_env)
    snapshot = clean_env / "huggingface" / "hub" / "models--adefossez--HTDemucs" / "snapshots" / COMMIT
    (snapshot / "htdemucs.yaml").write_text("models: [")
    assert not htdemucs_cached(clean_env / "huggingface")


def _run(code: str, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], cwd=WORKER_DIR, env=env, capture_output=True, text=True,
                          timeout=60)


def test_hub_resolves_htdemucs_from_cache_without_connecting(tmp_path):
    """The real huggingface_hub, imported after models_dir() as in warmup(), never opens a connection."""
    models = fake_hub_cache(tmp_path / "models")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(0.2)
    connections = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except OSError:
                continue
            connections.append(conn)
            conn.close()

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    env = {k: v for k, v in os.environ.items() if k not in ("HF_HOME", "HF_HUB_OFFLINE", "TORCH_HOME")}
    env.update(PEREPEV_MODELS_DIR=str(models), HF_ENDPOINT=f"http://127.0.0.1:{listener.getsockname()[1]}")
    code = ("from perepev_worker.runtime import models_dir; models_dir()\n"
            "from huggingface_hub import hf_hub_download\n"
            "print(hf_hub_download('adefossez/HTDemucs', 'htdemucs.yaml'))\n"
            "print(hf_hub_download('adefossez/HTDemucs', '955717e8.safetensors'))\n")
    try:
        result = _run(code, env)
    finally:
        stop.set()
        thread.join()
        listener.close()
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == [
        str(models / "huggingface" / "hub" / "models--adefossez--HTDemucs" / "snapshots" / COMMIT / name)
        for name in ("htdemucs.yaml", "955717e8.safetensors")
    ]
    assert connections == []


def test_worker_modules_do_not_import_the_hub_before_models_dir():
    """huggingface_hub reads HF_HUB_OFFLINE once, at import: models_dir() in warmup() must come first."""
    code = ("import sys\n"
            "import perepev_worker.main, perepev_worker.runtime, perepev_worker.separate, perepev_worker.words\n"
            "import perepev_worker.pitch, perepev_worker.score, perepev_worker.track\n"
            "print('huggingface_hub' in sys.modules, 'torch' in sys.modules)")
    result = _run(code, dict(os.environ))
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["False", "False"]


def test_hub_http_requests_stay_out_of_the_log(monkeypatch, tmp_path):
    """huggingface_hub 2.x logs every request through its own httpx copy ("httpx2") at INFO."""
    monkeypatch.delenv("PEREPEV_SERVER", raising=False)
    monkeypatch.delenv("PEREPEV_WORKER_TOKEN", raising=False)
    # main() quiets these loggers (and would configure the root logger without pytest's
    # handlers); restore all of it so the following tests see the logging they started with.
    root = logging.getLogger()
    levels = {name: logging.getLogger(name).level for name in ("httpx", "httpx2")}
    root_level, root_handlers = root.level, list(root.handlers)
    try:
        assert main(["--workdir", str(tmp_path)]) == 2
        for name in levels:
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING
    finally:
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)
        for handler in [h for h in root.handlers if h not in root_handlers]:
            root.removeHandler(handler)
        root.setLevel(root_level)
