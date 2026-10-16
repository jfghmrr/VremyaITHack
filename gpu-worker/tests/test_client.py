import json

import httpx
import pytest

from perepev_worker.client import AuthError, WorkerClient

TOKEN = "secret-token-value"


def make_client(handler):
    return WorkerClient("https://example.test/", TOKEN, "pc-1", transport=httpx.MockTransport(handler))


def test_lease_returns_job_and_sends_bearer_token():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"job": {"id": "j1", "kind": "score", "lease_ttl_s": 120, "params": {}}})

    job = make_client(handler).lease(["score", "track"])
    assert job == {"id": "j1", "kind": "score", "lease_ttl_s": 120, "params": {}}
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["url"] == "https://example.test/api/worker/lease"
    assert seen["body"] == {"worker": "pc-1", "kinds": ["score", "track"]}


def test_lease_204_means_no_job():
    assert make_client(lambda r: httpx.Response(204)).lease(["score"]) is None


def test_unauthorized_raises_without_leaking_token():
    with pytest.raises(AuthError) as err:
        make_client(lambda r: httpx.Response(401)).heartbeat()
    assert TOKEN not in str(err.value)
    assert TOKEN not in repr(make_client(lambda r: httpx.Response(204)))


def test_job_routes():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, request.content))
        if request.url.path.endswith("/input"):
            return httpx.Response(200, content=b"RIFF....")
        if "/asset/" in request.url.path:
            return httpx.Response(404) if "guide" in request.url.path else httpx.Response(200, content=b"ID3")
        return httpx.Response(204)

    c = make_client(handler)
    assert c.input("j1") == b"RIFF...."
    assert c.asset("j1", "instrumental.mp3") == b"ID3"
    assert c.asset("j1", "guide.mp3") is None
    c.progress("j1", "separating")
    c.put_file("j1", "guide.mp3", b"abc")
    c.complete("j1", {"duration_s": 1.0})
    c.fail("j1", "boom")
    c.heartbeat()
    paths = [(m, p) for m, p, _ in calls]
    assert paths == [
        ("GET", "/api/worker/jobs/j1/input"),
        ("GET", "/api/worker/jobs/j1/asset/instrumental.mp3"),
        ("GET", "/api/worker/jobs/j1/asset/guide.mp3"),
        ("POST", "/api/worker/jobs/j1/progress"),
        ("PUT", "/api/worker/jobs/j1/files/guide.mp3"),
        ("POST", "/api/worker/jobs/j1/complete"),
        ("POST", "/api/worker/jobs/j1/fail"),
        ("POST", "/api/worker/heartbeat"),
    ]
    assert json.loads(calls[3][2]) == {"stage": "separating"}
    assert calls[4][2] == b"abc"
    assert json.loads(calls[6][2]) == {"error": "boom"}
    assert json.loads(calls[7][2]) == {"worker": "pc-1"}


def test_put_file_rejects_oversized_and_unknown_names():
    c = make_client(lambda r: httpx.Response(204))
    with pytest.raises(ValueError):
        c.put_file("j1", "../etc/passwd", b"x")
    with pytest.raises(ValueError):
        c.put_file("j1", "guide.mp3", b"x" * (20 * 1024 * 1024 + 1))


def retrying_client(handler):
    c = make_client(handler)
    c._sleep = lambda s: None  # no real back-off pauses in tests
    return c


def test_complete_and_put_file_retry_twice_on_5xx_and_transport_errors():
    # complete is idempotent on the server, a re-sent file replaces the same name.
    answers = iter([httpx.Response(503), httpx.ConnectError("reset"), httpx.Response(204)])
    calls = []

    def handler(request):
        calls.append(request.url.path)
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    retrying_client(handler).complete("j1", {"duration_s": 1.0})
    assert calls == ["/api/worker/jobs/j1/complete"] * 3

    answers = iter([httpx.Response(502), httpx.Response(204)])
    calls.clear()
    retrying_client(handler).put_file("j1", "guide.mp3", b"G")
    assert calls == ["/api/worker/jobs/j1/files/guide.mp3"] * 2


def test_retries_stop_after_two_and_never_on_4xx():
    calls = []

    def always(status):
        def handler(request):
            calls.append(status)
            return httpx.Response(status)
        return handler

    with pytest.raises(httpx.HTTPStatusError):
        retrying_client(always(500)).complete("j1", {})
    assert calls == [500] * 3
    calls.clear()
    with pytest.raises(httpx.HTTPStatusError):
        retrying_client(always(400)).complete("j1", {})
    assert calls == [400]
    calls.clear()
    with pytest.raises(AuthError):
        retrying_client(always(401)).put_file("j1", "guide.mp3", b"G")
    assert calls == [401]
