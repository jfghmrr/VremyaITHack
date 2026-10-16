from pathlib import Path

from perepev_worker.main import Pipelines, default_pipelines, handle_job, main, parse_args
from perepev_worker.track import TrackResult


class FakeClient:
    def __init__(self, assets=None):
        self.calls = []
        self.assets = assets or {}

    def input(self, job_id):
        self.calls.append(("input", job_id))
        return b"RIFF-wav-bytes"

    def asset(self, job_id, name):
        self.calls.append(("asset", name))
        return self.assets.get(name)

    def progress(self, job_id, stage):
        self.calls.append(("progress", stage))

    def put_file(self, job_id, name, data):
        self.calls.append(("put", name, data))

    def complete(self, job_id, output):
        self.calls.append(("complete", output))

    def fail(self, job_id, error):
        self.calls.append(("fail", error))


TRACK_ID = "3f2c8a1e-5b7d-4c1a-9e2f-0a1b2c3d4e5f"
TRACK_JOB = {"id": "t1", "kind": "track", "lease_ttl_s": 120,
             "params": {"language": "en", "title": "x", "margin_s": 2.0, "track_id": TRACK_ID}}
SCORE_JOB = {"id": "j1", "kind": "score", "lease_ttl_s": 120,
             "params": {"sample_rate": 16000, "language": "ru", "duration_s": 3.0, "words": [],
                        "assets": ["instrumental.mp3", "guide.mp3"], "mode": "headphones"}}


def test_score_job_downloads_assets_completes_and_deletes_files(tmp_path):
    seen = {}

    def score(wav, params, assets):
        seen["wav"] = wav
        seen["bytes"] = Path(wav).read_bytes()
        seen["assets"] = {k: Path(v).read_bytes() for k, v in assets.items()}
        return {"frames": [], "words": [], "asr_text": "", "bleed": {"instrumental": 0.0, "guide": 0.0}, "models": {}}

    client = FakeClient(assets={"instrumental.mp3": b"I", "guide.mp3": b"G"})
    assert handle_job(client, SCORE_JOB, Pipelines(score=score, track=None), tmp_path)
    assert seen["bytes"] == b"RIFF-wav-bytes"
    assert seen["assets"] == {"instrumental.mp3": b"I", "guide.mp3": b"G"}
    assert client.calls[-1][0] == "complete"
    assert not Path(seen["wav"]).exists()
    assert list(tmp_path.iterdir()) == []


def test_missing_asset_is_skipped(tmp_path):
    seen = {}

    def score(wav, params, assets):
        seen["names"] = sorted(assets)
        return {}

    client = FakeClient(assets={"instrumental.mp3": b"I"})
    handle_job(client, SCORE_JOB, Pipelines(score=score, track=None), tmp_path)
    assert seen["names"] == ["instrumental.mp3"]


def test_track_job_uploads_files_then_completes(tmp_path):
    def track(wav, params, progress):
        progress("separating")
        progress("words")
        return TrackResult(files={"reference.json": b"{}", "guide.mp3": b"G"}, output={"duration_s": 20.0})

    client = FakeClient()
    assert handle_job(client, TRACK_JOB, Pipelines(score=None, track=track), tmp_path)
    kinds = [c[0] for c in client.calls]
    assert kinds == ["input", "progress", "progress", "put", "put", "complete"]
    assert client.calls[-1] == ("complete", {"duration_s": 20.0})


def test_track_job_without_track_id_fails_before_download(tmp_path):
    def track(wav, params, progress):
        raise AssertionError("must not run")

    client = FakeClient()
    job = {**TRACK_JOB, "params": {"language": "en", "title": "x", "margin_s": 2.0}}
    assert not handle_job(client, job, Pipelines(score=None, track=track), tmp_path)
    assert client.calls == [("fail", "track job params lack track_id")]
    assert list(tmp_path.iterdir()) == []


def test_track_pipeline_names_the_song_after_track_id(monkeypatch, tmp_path):
    # web/src/lib/catalog.ts rejects a reference whose id differs from the requested "my-<track uuid>".
    import perepev_worker.track as track_mod

    seen = {}

    def fake_process_track(wav, language, title, *, margin_s, song_id, progress):
        seen.update(language=language, title=title, margin_s=margin_s, song_id=song_id)
        return TrackResult(files={}, output={})

    monkeypatch.setattr(track_mod, "process_track", fake_process_track)
    params = {"job_id": "t1", **TRACK_JOB["params"]}
    default_pipelines().track(tmp_path / "in.wav", params, lambda stage: None)
    assert seen == {"language": "en", "title": "x", "margin_s": 2.0, "song_id": f"my-{TRACK_ID}"}


def test_pipeline_error_reports_fail_and_cleans_up(tmp_path):
    def score(wav, params, assets):
        raise RuntimeError("CUDA out of memory")

    client = FakeClient()
    assert not handle_job(client, SCORE_JOB, Pipelines(score=score, track=None), tmp_path)
    assert client.calls[-1] == ("fail", "RuntimeError: CUDA out of memory")
    assert list(tmp_path.iterdir()) == []


def test_unknown_kind_fails(tmp_path):
    client = FakeClient()
    assert not handle_job(client, {"id": "c1", "kind": "catalog", "params": {}}, Pipelines(None, None), tmp_path)
    assert client.calls == [("fail", "unsupported job kind: catalog")]


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("PEREPEV_SERVER", "https://perepev.example")
    monkeypatch.setenv("PEREPEV_WORKER_TOKEN", "tok")
    args = parse_args([])
    assert args.server == "https://perepev.example" and args.token == "tok"
    args = parse_args(["--server", "http://127.0.0.1:3001", "--worker", "mac-1"])
    assert args.server == "http://127.0.0.1:3001" and args.worker == "mac-1"


def test_startup_removes_job_folders_left_by_a_killed_worker(monkeypatch, tmp_path):
    # A kill mid-job (reboot, task restart, CUDA crash) skips handle_job's cleanup: voice
    # recordings and private stems must not outlive the next start.
    monkeypatch.delenv("PEREPEV_SERVER", raising=False)
    monkeypatch.delenv("PEREPEV_WORKER_TOKEN", raising=False)
    for name in ("job-abc123", "job-def456"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "input.wav").write_bytes(b"RIFF voice")
    (tmp_path / "job-def456" / "guide.mp3").write_bytes(b"ID3")
    (tmp_path / "keep.txt").write_text("not a job folder")
    assert main(["--workdir", str(tmp_path)]) == 2  # no server configured: exits after the cleanup
    assert sorted(p.name for p in tmp_path.iterdir()) == ["keep.txt"]


# --- lanes: a bad job or an unexpected error must not kill a lane while heartbeats keep the
# worker "online" on the server.
import logging
import threading

import httpx
import pytest

import perepev_worker.main as main_mod


class LaneClient(FakeClient):
    """Fake WorkerClient for _lane: lease answers come from a script; then it stops the lane."""

    script: list = []
    stop: threading.Event | None = None
    instances: list = []

    def __init__(self, server, token, worker):
        super().__init__()
        LaneClient.instances.append(self)

    def lease(self, kinds):
        if not LaneClient.script:
            LaneClient.stop.set()
            return None
        step = LaneClient.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    def close(self):
        pass


def run_lane(monkeypatch, tmp_path, script, pipelines):
    monkeypatch.setattr(main_mod, "WorkerClient", LaneClient)
    monkeypatch.setattr(main_mod, "RETRY_S", 0.01)
    LaneClient.script, LaneClient.instances = list(script), []
    LaneClient.stop = stop = threading.Event()
    args = parse_args(["--server", "http://test", "--workdir", str(tmp_path)])
    args.token = "t"
    fatal = []
    lane = threading.Thread(target=main_mod._lane, args=(args, ["score"], pipelines, stop, fatal), daemon=True)
    lane.start()
    lane.join(timeout=10)
    assert not lane.is_alive(), "the lane finished its script"
    return LaneClient.instances[0], fatal


def ok_score(wav, params, assets):
    return {"frames": [], "words": [], "asr_text": "", "bleed": {"instrumental": 0.0, "guide": 0.0}, "models": {}}


def test_lane_survives_bad_jobs_and_unexpected_errors(monkeypatch, tmp_path, caplog):
    request = httpx.Request("POST", "http://test/api/worker/lease")
    script = [
        {"kind": "score", "params": {}},  # no id: KeyError outside the pipeline
        KeyError("job"),  # malformed lease answer
        httpx.HTTPStatusError("bad", request=request, response=httpx.Response(500, request=request)),
        OSError("disk full"),
        SCORE_JOB,  # still served afterwards
    ]
    with caplog.at_level(logging.WARNING, logger="perepev_worker"):
        client, fatal = run_lane(monkeypatch, tmp_path, script, Pipelines(score=ok_score, track=None))
    assert fatal == []
    assert client.calls[-1][0] == "complete", client.calls
    assert any("HTTP 500" in r.getMessage() for r in caplog.records), [r.getMessage() for r in caplog.records]


def test_job_folder_error_fails_the_job_instead_of_killing_the_lane(monkeypatch, tmp_path):
    def broken_mkdtemp(**kwargs):
        raise OSError("no space left on device")

    monkeypatch.setattr(main_mod.tempfile, "mkdtemp", broken_mkdtemp)
    client = FakeClient()
    assert not handle_job(client, SCORE_JOB, Pipelines(score=ok_score, track=None), tmp_path)
    assert client.calls[-1][0] == "fail"
    assert "no space left" in client.calls[-1][1]


def test_progress_failure_does_not_abort_a_track_job(tmp_path):
    class FlakyProgress(FakeClient):
        def progress(self, job_id, stage):
            self.calls.append(("progress", stage))
            raise httpx.ConnectError("Wi-Fi dropped")

    def track(wav, params, progress):
        progress("separating")
        progress("melody")
        return TrackResult(files={"reference.json": b"{}"}, output={"duration_s": 20.0})

    client = FlakyProgress()
    assert handle_job(client, TRACK_JOB, Pipelines(score=None, track=track), tmp_path)
    assert [c[0] for c in client.calls] == ["input", "progress", "progress", "put", "complete"]


def test_heartbeat_failures_are_warnings_with_the_status(monkeypatch, caplog):
    class FailingHeartbeat:
        def __init__(self, *a):
            pass

        def heartbeat(self):
            request = httpx.Request("POST", "http://test/api/worker/heartbeat")
            raise httpx.HTTPStatusError("bad gateway", request=request, response=httpx.Response(502, request=request))

        def close(self):
            pass

    monkeypatch.setattr(main_mod, "WorkerClient", FailingHeartbeat)
    monkeypatch.setattr(main_mod, "HEARTBEAT_S", 0.01)
    stop = threading.Event()
    args = parse_args(["--server", "http://test"])
    beat = threading.Thread(target=main_mod._heartbeats, args=(args, stop), daemon=True)
    with caplog.at_level(logging.WARNING, logger="perepev_worker"):
        beat.start()
        threading.Event().wait(0.2)
        stop.set()
        beat.join(timeout=5)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING and "heartbeat" in r.getMessage()]
    assert warnings and "HTTP 502" in warnings[0].getMessage()
