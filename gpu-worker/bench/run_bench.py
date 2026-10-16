"""Precise-scoring benchmark: synthetic takes sent through the perf API exactly like a browser.

The separated guide vocal of each catalog song plays the "perfect singer"; the other cases
are transforms of it (pitch shift, delay, one detuned phrase), another song's vocal, a sine
hum of the reference melody, silence and speaker bleed. Each take is streamed as 16 kHz mono
PCM16 in 5 s chunks (`POST /api/perf`, `PUT .../chunk?seq=n`, `POST .../finish`), then
`GET /api/perf/{id}` is polled until a final status. Models run on whichever worker serves
the API; this script only transforms audio (numpy/scipy/soundfile) and talks HTTP.

    uv run python bench/run_bench.py --server http://127.0.0.1:8091 \
        --hardware "RTX 3070 Ti 8 GB, driver 610.74" --out bench/RESULTS.md --json bench/results.json

The API allows 30 performances per hour per client address and a full run sends 54. Against a
local test API started with TRUST_PROXY=true, add --spread-ips: each take then comes from its own
address in the benchmark range 198.18.0.0/15 (X-Forwarded-For), like separate visitors behind the proxy.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shlex
import sys
import time
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

# The worker's own speaker-bleed measure (numpy only, no models): the API does not return the
# bleed values, so the bench recomputes them on the same take to explain a "bleed" cap.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from perepev_worker.bleed import bleed as worker_bleed  # noqa: E402

SR = 16000
CHUNK_SAMPLES = SR * 5  # the browser sends 5 s chunks
POLL_S = 0.25  # the browser polls every 0.7 s; a finer poll only sharpens the latency figure
POLL_LIMIT_S = 25.0  # the browser gives up after 25 s
CONSENT_VERSION = "2026-10-17"
DEFAULT_SONGS = ["cn-earth", "cn-wonder", "va-angel", "jw-oh-mallory", "jw-little-tomcat", "jw-same-boat"]
CASES = ["perfect", "shift+3", "shift-3", "delay400", "detune", "other-vocal", "hum", "silence", "bleed"]
# crates/scoring-core/src/config.rs WEIGHT_*: the score before caps, for capped takes.
WEIGHTS = {"intervals": 0.45, "rhythm": 0.25, "stability": 0.15, "coverage": 0.15}
BLEED_DB = -6.0
BLEED_DELAY_S = 0.025  # speaker-to-microphone path plus output latency
DETUNE_STEP_S = 0.5
DETUNE_SEMITONES = 1.0
FADE_S = 0.03


# --- audio ----------------------------------------------------------------------------------

def load_mono(path: Path, sr: int = SR) -> np.ndarray:
    y, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    return resample(y.mean(axis=1), file_sr, sr)


def resample(y: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to:
        return np.asarray(y, dtype=np.float32)
    ratio = Fraction(sr_to, sr_from)
    return resample_poly(y, ratio.numerator, ratio.denominator).astype(np.float32)


def fit(y: np.ndarray, n: int) -> np.ndarray:
    """Trim or zero-pad to exactly n samples."""
    return np.asarray(y[:n] if len(y) >= n else np.pad(y, (0, n - len(y))), dtype=np.float32)


def _stft(y: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    window = np.hanning(n_fft)
    y = np.pad(y, (n_fft // 2, n_fft // 2 + n_fft))
    starts = range(0, len(y) - n_fft + 1, hop)
    return np.array([np.fft.rfft(y[s:s + n_fft] * window) for s in starts])


def _istft(spec: np.ndarray, n_fft: int, hop: int, length: int) -> np.ndarray:
    window = np.hanning(n_fft)
    out = np.zeros(hop * (len(spec) - 1) + n_fft)
    norm = np.zeros_like(out)
    for i, frame in enumerate(spec):
        s = i * hop
        out[s:s + n_fft] += np.fft.irfft(frame, n_fft) * window
        norm[s:s + n_fft] += window ** 2
    out /= np.maximum(norm, 1e-8)
    return out[n_fft // 2:n_fft // 2 + length]


def time_stretch(y: np.ndarray, factor: float, n_fft: int = 1024, hop: int = 128) -> np.ndarray:
    """Phase-vocoder time stretch: the output is `factor` times longer, same pitch."""
    spec = _stft(np.asarray(y, dtype=np.float64), n_fft, hop)
    steps = np.arange(0, len(spec) - 1, 1.0 / factor)
    advance = 2 * np.pi * hop * np.arange(spec.shape[1]) / n_fft
    phase = np.angle(spec[0])
    spec = np.vstack([spec, np.zeros((2, spec.shape[1]))])
    out = np.empty((len(steps), spec.shape[1]), dtype=complex)
    for k, t in enumerate(steps):
        i, alpha = int(t), t - int(t)
        a, b = spec[i], spec[i + 1]
        out[k] = ((1 - alpha) * np.abs(a) + alpha * np.abs(b)) * np.exp(1j * phase)
        delta = np.angle(b) - np.angle(a) - advance
        phase = phase + advance + (delta - 2 * np.pi * np.round(delta / (2 * np.pi)))
    return _istft(out, n_fft, hop, int(round(len(y) * factor)))


def pitch_shift(y: np.ndarray, semitones: float) -> np.ndarray:
    """Shift pitch, keep duration: stretch by 2^(st/12), then resample back to the input length."""
    factor = 2.0 ** (semitones / 12.0)
    stretched = time_stretch(y, factor)
    ratio = Fraction(len(y), len(stretched)).limit_denominator(4000)
    shifted = fit(resample_poly(stretched, ratio.numerator, ratio.denominator).astype(np.float32), len(y))
    # The vocoder smears transients and loses about 3 dB on a voice; restore the input loudness.
    level = np.sqrt(np.mean(np.square(shifted, dtype=np.float64)))
    target = np.sqrt(np.mean(np.square(y, dtype=np.float64)))
    return (shifted * (target / level if level > 0 else 1.0)).astype(np.float32)


def ramp_mask(n: int, segments: list[tuple[int, int]], fade: int) -> np.ndarray:
    """1 inside the segments, 0 outside, with linear fades of `fade` samples."""
    mask = np.zeros(n)
    for a, b in segments:
        mask[max(a, 0):min(b, n)] = 1.0
    kernel = np.ones(fade) / fade
    return np.clip(np.convolve(mask, kernel, mode="same"), 0.0, 1.0)


def detune_phrase(y: np.ndarray, phrase: dict, step_s: float = DETUNE_STEP_S,
                  semitones: float = DETUNE_SEMITONES) -> np.ndarray:
    """Inside one phrase, alternate +st / -st every `step_s`: wrong intervals, same key on average."""
    start, end = int(phrase["start_s"] * SR), int(phrase["end_s"] * SR)
    up, down = pitch_shift(y, semitones), pitch_shift(y, -semitones)
    fade = int(FADE_S * SR)
    step = int(step_s * SR)
    ups = [(s, min(s + step, end)) for s in range(start, end, 2 * step)]
    m_up = ramp_mask(len(y), ups, fade)
    m_phrase = ramp_mask(len(y), [(start, end)], fade)
    detuned = m_up * up + (1 - m_up) * down
    return (m_phrase * detuned + (1 - m_phrase) * y).astype(np.float32)


def delay(y: np.ndarray, seconds: float) -> np.ndarray:
    return fit(np.concatenate([np.zeros(int(round(seconds * SR)), dtype=np.float32), y]), len(y))


def hum(reference: dict, n: int, amplitude: float = 0.25) -> np.ndarray:
    """A pure sine following the reference melody (10 ms grid), silent between notes."""
    hop = int(reference["hop_ms"] * SR / 1000)
    midi = np.array([np.nan if m is None else m for m in reference["f0_midi"]], dtype=np.float64)
    per_sample = np.repeat(midi, hop)[:n]
    per_sample = np.pad(per_sample, (0, n - len(per_sample)), constant_values=np.nan)
    voiced = ~np.isnan(per_sample)
    hz = np.where(voiced, 440.0 * 2 ** ((np.nan_to_num(per_sample, nan=69.0) - 69) / 12), 0.0)
    phase = 2 * np.pi * np.cumsum(hz) / SR
    envelope = ramp_mask(n, _runs(voiced), int(0.02 * SR))
    return (amplitude * envelope * np.sin(phase)).astype(np.float32)


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    edges = np.flatnonzero(np.diff(np.concatenate([[0], flags.astype(np.int8), [0]])))
    return list(zip(edges[::2], edges[1::2]))


@dataclass
class Song:
    id: str
    language: str
    duration_s: float
    guide: np.ndarray
    instrumental: np.ndarray
    reference: dict

    @property
    def n(self) -> int:
        return int(round(self.duration_s * SR))


def load_song(songs_dir: Path, song_id: str) -> Song:
    folder = songs_dir / song_id
    reference = json.loads((folder / "reference.json").read_text(encoding="utf-8"))
    index = json.loads((songs_dir / "index.json").read_text(encoding="utf-8"))
    entries = index if isinstance(index, list) else index.get("songs", [])
    language = next((e.get("language") for e in entries if e.get("id") == song_id), None) or "en"
    duration = float(reference["duration_s"])
    n = int(round(duration * SR))
    return Song(song_id, language, duration, fit(load_mono(folder / "guide.mp3"), n),
                fit(load_mono(folder / "instrumental.mp3"), n), reference)


def longest_phrase(reference: dict) -> dict:
    return max(reference["phrases"], key=lambda p: p["end_s"] - p["start_s"])


def build_take(case: str, song: Song, donor: Song) -> tuple[np.ndarray, str, str]:
    """(16 kHz take, mode, description) for one case."""
    g, n = song.guide, song.n
    if case == "perfect":
        return g, "headphones", "guide vocal as is"
    if case in ("shift+3", "shift-3"):
        st = 3.0 if case == "shift+3" else -3.0
        return pitch_shift(g, st), "headphones", f"guide pitch-shifted {st:+.0f} semitones (phase vocoder)"
    if case == "delay400":
        return delay(g, 0.4), "headphones", "guide 400 ms late"
    if case == "detune":
        p = longest_phrase(song.reference)
        return (detune_phrase(g, p), "headphones",
                f"phrase {p['start_s']:.2f}-{p['end_s']:.2f} s: +/-{DETUNE_SEMITONES:g} st alternating every {DETUNE_STEP_S:g} s")
    if case == "other-vocal":
        return fit(donor.guide, n), "headphones", f"guide vocal of {donor.id}"
    if case == "hum":
        return hum(song.reference, n), "headphones", "sine following the reference melody"
    if case == "silence":
        return np.zeros(n, dtype=np.float32), "headphones", "digital silence"
    if case == "bleed":
        gain = 10 ** (BLEED_DB / 20)
        played = gain * (g + song.instrumental)
        return (delay(played, BLEED_DELAY_S), "headphones",
                f"user silent; instrumental + guide from a speaker at {BLEED_DB:g} dB, {BLEED_DELAY_S * 1000:.0f} ms late")
    raise ValueError(case)


# --- HTTP (same requests as web/src/lib/precise/uploader.ts) --------------------------------

def to_pcm16(y: np.ndarray) -> bytes:
    y = np.nan_to_num(np.asarray(y, dtype=np.float64))
    pcm = np.where(y >= 0, np.round(np.clip(y, 0, 1) * 32767), np.round(np.clip(y, -1, 0) * 32768))
    return pcm.astype("<i2").tobytes()


@dataclass
class Outcome:
    status: str
    latency_s: float | None
    result: dict | None
    error: str | None = None
    perf_id: str | None = None


def run_take(server: str, origin: str, song_id: str, mode: str, take: np.ndarray, client_ip: str | None) -> Outcome:
    headers = {"Origin": origin, "X-Perepev-Request": "1", "User-Agent": "perepev-bench/1"}
    if client_ip:
        headers["X-Forwarded-For"] = client_ip
    with httpx.Client(base_url=server, headers=headers, timeout=30.0) as http:  # fresh guest cookie per take
        r = http.post("/api/perf", json={"songId": song_id, "mode": mode, "voiceConsent": True,
                                         "consentVersion": CONSENT_VERSION})
        if r.status_code != 201:
            return Outcome("error", None, None, f"POST /api/perf {r.status_code}: {r.text[:200]}")
        perf_id = r.json()["id"]
        pcm = to_pcm16(take)
        step = CHUNK_SAMPLES * 2
        chunks = [pcm[i:i + step] for i in range(0, len(pcm), step)]
        for seq, chunk in enumerate(chunks):
            r = http.put(f"/api/perf/{perf_id}/chunk", params={"seq": seq}, content=chunk,
                         headers={"Content-Type": "application/octet-stream"})
            if r.status_code != 204:
                return Outcome("error", None, None, f"chunk {seq}: {r.status_code} {r.text[:200]}", perf_id)
        r = http.post(f"/api/perf/{perf_id}/finish", json={"chunks": len(chunks)})
        finished = time.monotonic()
        if r.status_code != 202:
            return Outcome("error", None, None, f"finish: {r.status_code} {r.text[:200]}", perf_id)
        while True:
            body = http.get(f"/api/perf/{perf_id}").json()
            waited = time.monotonic() - finished
            if body["status"] in ("done", "failed", "offline"):
                return Outcome(body["status"], round(waited, 2), body.get("result"), None, perf_id)
            if waited >= POLL_LIMIT_S:
                return Outcome("timeout", round(waited, 2), None, None, perf_id)
            time.sleep(POLL_S)


# --- expectations ---------------------------------------------------------------------------

EXPECT = {
    "perfect": "score >= 85, no bleed cap",
    "shift+3": "score >= 85",
    "shift-3": "score >= 85",
    "delay400": "rhythm < perfect",
    "detune": "intervals < perfect",
    "other-vocal": 'cap "words", score <= 40',
    "hum": 'cap "words", score <= 40',
    "silence": "score < 20",
    "bleed": 'cap "bleed", score <= 30',
}


def check(case: str, res: dict | None, perfect: dict | None) -> tuple[bool | None, str]:
    """(passed, expectation); passed is None when there is no result to judge."""
    expectation = EXPECT[case]
    if res is None or (case in ("delay400", "detune") and perfect is None):
        return None, expectation
    score, cap, axes = res["score"], res.get("cap"), res["axes"]
    passed = {
        "perfect": lambda: score >= 85 and cap != "bleed",
        "shift+3": lambda: score >= 85,
        "shift-3": lambda: score >= 85,
        "delay400": lambda: axes["rhythm"] < perfect["axes"]["rhythm"],
        "detune": lambda: axes["intervals"] < perfect["axes"]["intervals"],
        "other-vocal": lambda: cap == "words" and score <= 40,
        "hum": lambda: cap == "words" and score <= 40,
        "silence": lambda: score < 20,
        "bleed": lambda: cap == "bleed" and score <= 30,
    }[case]()
    return passed, expectation


@dataclass
class Row:
    song: str
    case: str
    mode: str
    take: str
    outcome: Outcome
    passed: bool | None = None
    expectation: str = ""
    extra: dict = field(default_factory=dict)


def fmt(x, digits=2):
    return "—" if x is None else f"{x:.{digits}f}"


def uncapped(res: dict) -> float:
    return 100.0 * sum(w * res["axes"][axis] for axis, w in WEIGHTS.items())


def markdown(rows: list[Row], meta: dict) -> str:
    lines = [
        "# Precise-scoring benchmark (GPU worker)",
        "",
        f"- Date: {meta['date']}",
        f"- Worker hardware: {meta['hardware']}",
        f"- Models: {meta['models']}",
        f"- Server: test API `{meta['server']}` (branch `wt/bench`), scoring `precise-1`, deadline 20 s after finish",
        f"- Songs: {', '.join(meta['songs'])}",
        "- Command: `uv run python bench/run_bench.py " + shlex.join(meta["argv"]) + "`",
        "",
        "Every take is the length of the song, streamed as 16 kHz mono PCM16 in 5 s chunks through the",
        "browser endpoints, with a fresh guest each time. Latency is from the `finish` response to the",
        f"first poll that returned a final status (poll every {POLL_S} s). Axes are before caps;",
        "\"Uncapped\" is 100 x the weighted axes (scoring-core weights 0.45/0.25/0.15/0.15), i.e. the score",
        "the take would get without a cap. \"Guide bleed\" is the worker's own measure (`perepev_worker.bleed`,",
        "0..1, cap at >= 0.45) recomputed by the bench on the same take, because the API does not return it.",
        "",
        "## Cases",
        "",
        "| Case | Take | Mode | Expectation |",
        "|---|---|---|---|",
    ]
    seen = set()
    for row in rows:
        if row.case in seen:
            continue
        seen.add(row.case)
        take = {"detune": f"the longest phrase sung +/-{DETUNE_SEMITONES:g} semitone off, alternating every "
                          f"{DETUNE_STEP_S:g} s; the rest as is",
                "other-vocal": "guide vocal of the next bench song in the same language"}.get(row.case, row.take)
        lines.append(f"| {row.case} | {take} | {row.mode} | {row.expectation} |")
    lines += ["", "## Results", "",
              "| Song | Case | Status | Score | Uncapped | Intervals | Rhythm | Stability | Coverage | wordsSung | Cap | Guide bleed | Latency, s | Expectation |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for row in rows:
        o, r = row.outcome, row.outcome.result
        verdict = {True: "PASS", False: "**FAIL**", None: "—"}[row.passed]
        if r:
            a = r["axes"]
            lines.append(f"| {row.song} | {row.case} | {o.status} | {r['score']:.1f} | {uncapped(r):.1f} | {fmt(a['intervals'])} | "
                         f"{fmt(a['rhythm'])} | {fmt(a['stability'])} | {fmt(a['coverage'])} | {fmt(r.get('wordsSung'))} | "
                         f"{r.get('cap') or '—'} | {fmt(row.extra.get('guide_bleed'))} | {fmt(o.latency_s, 1)} | {verdict} |")
        else:
            lines.append(f"| {row.song} | {row.case} | {o.status} | — | — | — | — | — | — | — | — | {fmt(row.extra.get('guide_bleed'))} | {fmt(o.latency_s, 1)} | "
                         f"{verdict} {o.error or ''} |")
    by_case: dict[str, list[Row]] = {}
    for row in rows:
        by_case.setdefault(row.case, []).append(row)
    lines += ["", "## Summary by case", "", "| Case | Passed | Median score | Median latency, s | Max latency, s |", "|---|---|---|---|---|"]
    for case, rs in by_case.items():
        judged = [r for r in rs if r.passed is not None]
        scores = [r.outcome.result["score"] for r in rs if r.outcome.result]
        lat = [r.outcome.latency_s for r in rs if r.outcome.latency_s is not None and r.outcome.status == "done"]
        lines.append(f"| {case} | {sum(bool(r.passed) for r in judged)}/{len(rs)} | "
                     f"{fmt(float(np.median(scores)) if scores else None, 1)} | "
                     f"{fmt(float(np.median(lat)) if lat else None, 1)} | {fmt(max(lat) if lat else None, 1)} |")
    lat = [r.outcome.latency_s for r in rows if r.outcome.status == "done" and r.outcome.latency_s is not None]
    late = sum(1 for r in rows if r.outcome.status != "done")
    lines += ["", f"All takes: {len(rows)}; final `done`: {len(rows) - late}; not done (offline/failed/timeout/error): {late}.",
              f"Latency over done takes: median {fmt(float(np.median(lat)) if lat else None, 1)} s, "
              f"max {fmt(max(lat) if lat else None, 1)} s.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--server", default="http://127.0.0.1:8091")
    parser.add_argument("--origin", default=None, help="Origin header (default: the server URL)")
    parser.add_argument("--songs-dir", type=Path, default=Path(__file__).resolve().parents[2] / "web" / "static" / "songs")
    parser.add_argument("--songs", default=",".join(DEFAULT_SONGS))
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--hardware", default="unknown")
    parser.add_argument("--models", default="torchcrepe full (pitch), openai-whisper large-v3-turbo (words, CUDA, beam 5)")
    parser.add_argument("--spread-ips", action="store_true",
                        help="send each take from its own X-Forwarded-For address (test API with TRUST_PROXY=true)")
    parser.add_argument("--out", type=Path, help="Markdown results file")
    parser.add_argument("--json", type=Path, help="raw results (JSON)")
    args = parser.parse_args(argv)
    origin = args.origin or args.server.rstrip("/")
    song_ids = [s for s in args.songs.split(",") if s]
    cases = [c for c in args.cases.split(",") if c]
    unknown = set(cases) - set(CASES)
    if unknown:
        parser.error(f"unknown cases: {sorted(unknown)}")

    songs = {sid: load_song(args.songs_dir, sid) for sid in song_ids}
    by_language: dict[str, list[str]] = {}
    for sid in song_ids:
        by_language.setdefault(songs[sid].language, []).append(sid)

    def donor(sid: str) -> Song:
        group = by_language[songs[sid].language]
        others = group if len(group) > 1 else song_ids
        return songs[others[(others.index(sid) + 1) % len(others)]] if sid in others else songs[others[0]]

    rows: list[Row] = []
    serial = 0
    for sid in song_ids:
        song = songs[sid]
        perfect = None
        for case in cases:
            take, mode, description = build_take(case, song, donor(sid))
            serial += 1
            ip = f"198.18.{serial // 250}.{serial % 250 + 1}" if args.spread_ips else None
            outcome = run_take(args.server, origin, sid, mode, take, ip)
            if case == "perfect":
                perfect = outcome.result
            passed, expectation = check(case, outcome.result, perfect)
            guide_bleed = worker_bleed(take, song.guide, SR, other=song.instrumental)
            rows.append(Row(sid, case, mode, description, outcome, passed, expectation, {"guide_bleed": guide_bleed}))
            r = outcome.result or {}
            print(f"{sid:22} {case:12} {outcome.status:8} score={r.get('score', '—')!s:>5} cap={r.get('cap')!s:8} "
                  f"words={fmt(r.get('wordsSung'))} lat={fmt(outcome.latency_s, 1)} -> "
                  f"{ {True: 'PASS', False: 'FAIL', None: '—'}[passed]} {outcome.error or ''}", flush=True)

    meta = {"date": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "hardware": args.hardware,
            "models": args.models, "server": args.server, "songs": song_ids, "argv": argv if argv is not None else sys.argv[1:]}
    if args.json:
        args.json.write_text(json.dumps({"meta": meta, "rows": [
            {"song": r.song, "case": r.case, "mode": r.mode, "take": r.take, "status": r.outcome.status,
             "latency_s": r.outcome.latency_s, "guide_bleed": r.extra.get("guide_bleed"), "passed": r.passed, "expectation": r.expectation, "error": r.outcome.error,
             "result": None if not r.outcome.result else {k: r.outcome.result.get(k) for k in (
                 "score", "rawScore", "axes", "lag", "shift", "algorithm", "wordsChecked", "wordsSung", "wordsScore", "cap",
                 "constantTone")}}
            for r in rows]}, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.out:
        args.out.write_text(markdown(rows, meta), encoding="utf-8")
    failed = sum(1 for r in rows if r.passed is False)
    print(f"{len(rows)} takes, {failed} failed expectations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
