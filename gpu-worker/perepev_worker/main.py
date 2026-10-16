"""Worker entry point: warm up models once, then lease jobs (score lane + track lane) and heartbeat.

    python -m perepev_worker.main --server https://perepev.example     # token in PEREPEV_WORKER_TOKEN
    python -m perepev_worker.main --warmup                             # download and load models, exit
    python -m perepev_worker.main --selftest                           # run all pipelines on a synthetic clip
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx
import numpy as np

from .client import AuthError, WorkerClient

log = logging.getLogger("perepev_worker")
HEARTBEAT_S = 10.0
# First pause after a lane error; doubles up to 30 s and resets after a successful lease.
RETRY_S = 1.0
ASSET_NAMES = {"instrumental.mp3", "guide.mp3"}


@dataclass
class Pipelines:
    score: Callable | None
    track: Callable | None


def default_pipelines() -> Pipelines:
    from .score import process_score
    from .track import process_track

    def track(wav: Path, params: dict, progress: Callable[[str], None]):
        # The client loads the song as "my-<track uuid>" and rejects a reference with another id.
        song_id = f"my-{params['track_id']}"
        return process_track(wav, params.get("language") or "ru", params.get("title") or "Свой трек",
                             margin_s=float(params.get("margin_s", 2.0)), song_id=song_id, progress=progress)

    return Pipelines(score=process_score, track=track)


def _http_status(err: BaseException) -> str:
    """", HTTP 500" for an HTTP status error, otherwise empty: logs show what the server answered."""
    return f", HTTP {err.response.status_code}" if isinstance(err, httpx.HTTPStatusError) else ""


def _progress(client, job_id: str) -> Callable[[str], None]:
    """Progress is cosmetic: a failed POST (Wi-Fi blip, 5xx) is logged and the job goes on."""
    def report(stage: str) -> None:
        try:
            client.progress(job_id, stage)
        except AuthError:
            raise
        except Exception as err:
            log.warning("job %s: progress %r not sent (%s%s)", job_id, stage, type(err).__name__, _http_status(err))
    return report


def handle_job(client, job: dict, pipelines: Pipelines, workdir: Path) -> bool:
    """Run one leased job; report complete or fail. Input and outputs are deleted afterwards."""
    job_id, kind = job["id"], job.get("kind")
    params = {"job_id": job_id, **(job.get("params") or {})}
    if kind not in ("score", "track"):
        client.fail(job_id, f"unsupported job kind: {kind}")
        return False
    if kind == "track" and not (isinstance(params.get("track_id"), str) and params["track_id"]):
        client.fail(job_id, "track job params lack track_id")
        return False
    started = time.monotonic()
    tmp: Path | None = None
    try:
        tmp = Path(tempfile.mkdtemp(prefix="job-", dir=workdir))
        wav = tmp / "input.wav"
        wav.write_bytes(client.input(job_id))
        if kind == "score":
            assets = {}
            for name in params.get("assets") or []:
                data = client.asset(job_id, name) if name in ASSET_NAMES else None
                if data:
                    (tmp / name).write_bytes(data)
                    assets[name] = tmp / name
            output = pipelines.score(wav, params, assets)
        else:
            result = pipelines.track(wav, params, _progress(client, job_id))
            for name, data in result.files.items():
                client.put_file(job_id, name, data)
            output = result.output
        client.complete(job_id, output)
        log.info("job %s (%s) done in %.1f s", job_id, kind, time.monotonic() - started)
        return True
    except AuthError:
        raise
    except Exception as err:  # report every pipeline failure to the server and keep serving
        message = f"{type(err).__name__}: {err}"
        log.exception("job %s (%s) failed", job_id, kind)
        try:
            client.fail(job_id, message[:500])
        except Exception as fail_err:
            log.warning("could not report the failure of job %s (%s%s)", job_id, type(fail_err).__name__,
                        _http_status(fail_err))
        return False
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def clear_stale_jobs(workdir: Path) -> int:
    """Delete job folders left by a worker killed mid-job (reboot, task restart, crash).

    handle_job deletes its folder in `finally`, which a kill skips; the folders hold users'
    voice recordings and private-track stems, so they must not outlive the next start.
    """
    stale = [p for p in workdir.glob("job-*") if p.is_dir()]
    for path in stale:
        shutil.rmtree(path, ignore_errors=True)
    return len(stale)


def warmup() -> dict:
    """Download (first run) and load every model once; returns load times in seconds."""
    from .pitch import f0_frames
    from .runtime import device, models_dir
    from .separate import load_model as load_separator
    from .words import load_model as load_asr

    models_dir()
    times = {"device": device()}
    for name, step in (("separation", load_separator), ("asr", load_asr),
                       ("pitch", lambda: f0_frames(np.zeros(16000, dtype=np.float32), 16000))):
        t = time.monotonic()
        step()
        times[name] = round(time.monotonic() - t, 1)
    return times


def _synthetic_song(seconds: float, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """A sung-like line (A3-E4 notes with vibrato) and a quiet noise-and-bass accompaniment."""
    rng = np.random.default_rng(0)
    t = np.arange(int(seconds * sr)) / sr
    notes = np.array([57, 59, 60, 62, 64, 62, 60, 59])
    midi = notes[(t * len(notes) / seconds).astype(int) % len(notes)] + 0.3 * np.sin(2 * np.pi * 5.5 * t)
    phase = 2 * np.pi * np.cumsum(440 * 2 ** ((midi - 69) / 12)) / sr
    voice = 0.25 * sum(np.sin(h * phase) / h for h in range(1, 8))
    accompaniment = 0.05 * rng.standard_normal(len(t)) + 0.1 * np.sin(2 * np.pi * 110 * t)
    return voice.astype(np.float32), accompaniment.astype(np.float32)


def _write_wav(path: Path, y: np.ndarray, sr: int) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def selftest(args) -> bool:
    """Run the track and score pipelines on a synthetic 6 s clip; check the server if configured."""
    from .audio import write_mp3
    from .score import process_score
    from .track import process_track

    ok = True
    print(f"warmup: {warmup()}", flush=True)
    with tempfile.TemporaryDirectory(prefix="selftest-", dir=args.workdir) as tmp:
        tmp = Path(tmp)
        voice, accompaniment = _synthetic_song(6.0, 44100)
        _write_wav(tmp / "track.wav", voice + accompaniment, 44100)
        t = time.monotonic()
        result = process_track(tmp / "track.wav", "ru", "Самопроверка", margin_s=0.5, song_id="my-selftest")
        voiced = [m for m in __import__("json").loads(result.files["reference.json"])["f0_midi"] if m is not None]
        median = float(np.median(voiced)) if voiced else 0.0
        track_ok = len(voiced) > 100 and 56 <= median <= 65
        print(f"track pipeline: {time.monotonic() - t:.1f} s, voiced frames {len(voiced)}, median midi {median:.1f}"
              f" -> {'OK' if track_ok else 'FAIL'}", flush=True)
        ok &= track_ok

        voice16, accompaniment16 = _synthetic_song(6.0, 16000)
        _write_wav(tmp / "take.wav", voice16, 16000)
        write_mp3(tmp / "guide.mp3", voice16, 16000)
        write_mp3(tmp / "instrumental.mp3", accompaniment16, 16000)
        t = time.monotonic()
        out = process_score(tmp / "take.wav", {"language": "ru", "words": [], "mode": "headphones"},
                            {"guide.mp3": tmp / "guide.mp3", "instrumental.mp3": tmp / "instrumental.mp3"})
        score_ok = out["bleed"]["guide"] > 0.8 and sum(f["midi"] is not None for f in out["frames"]) > 300
        print(f"score pipeline: {time.monotonic() - t:.1f} s, bleed {out['bleed']} -> {'OK' if score_ok else 'FAIL'}",
              flush=True)
        ok &= score_ok
    if args.server and args.token:
        client = WorkerClient(args.server, args.token, args.worker)
        try:
            client.heartbeat()
            print(f"server {args.server}: token accepted -> OK", flush=True)
        except (AuthError, httpx.HTTPError) as err:
            print(f"server {args.server}: {err} -> FAIL", flush=True)
            ok = False
        finally:
            client.close()
    else:
        print("server: not configured, connection not checked", flush=True)
    print("SELFTEST OK" if ok else "SELFTEST FAILED", flush=True)
    return ok


def _lane(args, kinds: list[str], pipelines: Pipelines, stop: threading.Event, fatal: list) -> None:
    """Lease and run jobs until stopped. Only a rejected token stops the worker: any other error
    is logged and retried, because heartbeats keep reporting the worker online while a lane runs."""
    client = WorkerClient(args.server, args.token, args.worker)
    delay = RETRY_S
    lane = "/".join(kinds)
    try:
        while not stop.is_set():
            try:
                job = client.lease(kinds)
                delay = RETRY_S
                if job:
                    log.info("leased %s job %s", job.get("kind"), job.get("id"))
                    handle_job(client, job, pipelines, args.workdir)
            except AuthError as err:
                log.error("%s; check the worker token", err)
                fatal.append(err)
                stop.set()
            except httpx.HTTPError as err:
                log.warning("%s lane: server unavailable (%s%s); retrying in %.1f s", lane, type(err).__name__,
                            _http_status(err), delay)
                stop.wait(delay)
                delay = min(delay * 2, 30.0)
            except Exception as err:
                log.warning("%s lane: unexpected %s: %s; retrying in %.1f s", lane, type(err).__name__, err, delay,
                            exc_info=True)
                stop.wait(delay)
                delay = min(delay * 2, 30.0)
    finally:
        client.close()


def _heartbeats(args, stop: threading.Event) -> None:
    client = WorkerClient(args.server, args.token, args.worker)
    try:
        while not stop.wait(HEARTBEAT_S):
            try:
                client.heartbeat()
            except Exception as err:  # lanes decide about auth errors; this thread keeps beating
                log.warning("heartbeat failed (%s%s)", type(err).__name__, _http_status(err))
    finally:
        client.close()


def serve(args) -> int:
    log.info("warming up models: %s", warmup())
    log.info("worker %s serving %s", args.worker, args.server)
    pipelines = default_pipelines()
    stop, fatal = threading.Event(), []
    # Score jobs have a 20 s deadline, so they get their own lane and never queue behind a track job.
    threads = [threading.Thread(target=_lane, args=(args, ["score"], pipelines, stop, fatal), name="score", daemon=True),
               threading.Thread(target=_lane, args=(args, ["track"], pipelines, stop, fatal), name="track", daemon=True),
               threading.Thread(target=_heartbeats, args=(args, stop), name="heartbeat", daemon=True)]
    for thread in threads:
        thread.start()
    try:
        while not stop.wait(1.0):
            pass
    except KeyboardInterrupt:
        log.info("stopping")
        stop.set()
    for thread in threads[:2]:
        thread.join(timeout=5)
    return 2 if fatal else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="perepev_worker.main", description="Perepev GPU worker")
    parser.add_argument("--server", default=os.environ.get("PEREPEV_SERVER"), help="server URL (or PEREPEV_SERVER)")
    parser.add_argument("--token", default=os.environ.get("PEREPEV_WORKER_TOKEN"),
                        help="worker token; prefer the PEREPEV_WORKER_TOKEN environment variable")
    parser.add_argument("--worker", default=os.environ.get("PEREPEV_WORKER_NAME") or socket.gethostname(),
                        help="worker name shown on the server")
    parser.add_argument("--workdir", type=Path, default=Path(tempfile.gettempdir()) / "perepev-worker",
                        help="temporary job files (deleted after each job)")
    parser.add_argument("--warmup", action="store_true", help="download and load the models, then exit")
    parser.add_argument("--selftest", action="store_true", help="run the pipelines on a synthetic clip, then exit")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(threadName)s %(message)s")
    # httpx logs every request at INFO: a lease every 25 s would flood the worker log.
    # huggingface_hub 2.x sends its requests through its own copy of httpx, logged as "httpx2".
    for name in ("httpx", "httpx2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    args.workdir.mkdir(parents=True, exist_ok=True)
    removed = clear_stale_jobs(args.workdir)
    if removed:
        log.info("removed %d job folder(s) left by a previous run", removed)
    if args.warmup:
        print(f"models ready: {warmup()}", flush=True)
        return 0
    if args.selftest:
        return 0 if selftest(args) else 1
    if not args.server or not args.token:
        print("Set --server (or PEREPEV_SERVER) and PEREPEV_WORKER_TOKEN.", file=sys.stderr)
        return 2
    return serve(args)


if __name__ == "__main__":
    sys.exit(main())
