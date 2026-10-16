"""HTTP client for the C2 worker protocol (outbound only, bearer token)."""
from __future__ import annotations

import time
from urllib.parse import quote

import httpx

FILE_NAMES = {"instrumental.mp3", "guide.mp3", "backing.mp3", "reference.json", "lyrics.words.json"}
MAX_FILE_BYTES = 20 * 1024 * 1024
LEASE_WAIT_S = 25.0
# complete and put_file are retried this many times on transport errors and 5xx (1 s, then 2 s
# apart): complete is idempotent on the server, and a re-sent file replaces the same name.
RETRIES = 2


class AuthError(RuntimeError):
    """The server rejected the worker token (never contains the token itself)."""


class WorkerClient:
    def __init__(self, server: str, token: str, worker: str, *, transport: httpx.BaseTransport | None = None,
                 timeout_s: float = 60.0):
        self.server = server.rstrip("/")
        self.worker = worker
        self._http = httpx.Client(
            base_url=self.server, timeout=timeout_s, transport=transport, follow_redirects=False,
            headers={"Authorization": f"Bearer {token}", "User-Agent": "perepev-worker/0.1"},
        )
        self._sleep = time.sleep

    def __repr__(self) -> str:
        return f"WorkerClient({self.server!r}, worker={self.worker!r})"

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        response = self._http.request(method, path, **kwargs)
        if response.status_code in (401, 403):
            raise AuthError(f"server rejected the worker token (HTTP {response.status_code})")
        return response

    def _ok(self, method: str, path: str, **kwargs) -> httpx.Response:
        response = self._request(method, path, **kwargs)
        response.raise_for_status()
        return response

    def _ok_retrying(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Like _ok, but transport errors and 5xx are retried RETRIES times; 4xx and auth errors are not."""
        for attempt in range(RETRIES + 1):
            try:
                response = self._request(method, path, **kwargs)
                if response.status_code < 500 or attempt == RETRIES:
                    response.raise_for_status()
                    return response
            except httpx.TransportError:
                if attempt == RETRIES:
                    raise
            self._sleep(float(2**attempt))
        raise AssertionError("unreachable")

    @staticmethod
    def _job(job_id: str) -> str:
        return f"/api/worker/jobs/{quote(str(job_id), safe='')}"

    def lease(self, kinds: list[str]) -> dict | None:
        """Long-poll (about 25 s) for a job; None when the server has nothing. Counts as a heartbeat."""
        response = self._ok("POST", "/api/worker/lease", json={"worker": self.worker, "kinds": kinds},
                            timeout=LEASE_WAIT_S + 15)
        return None if response.status_code == 204 else response.json()["job"]

    def heartbeat(self) -> None:
        self._ok("POST", "/api/worker/heartbeat", json={"worker": self.worker})

    def input(self, job_id: str) -> bytes:
        return self._ok("GET", f"{self._job(job_id)}/input").content

    def asset(self, job_id: str, name: str) -> bytes | None:
        response = self._request("GET", f"{self._job(job_id)}/asset/{quote(name, safe='')}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.content

    def progress(self, job_id: str, stage: str) -> None:
        self._ok("POST", f"{self._job(job_id)}/progress", json={"stage": stage})

    def put_file(self, job_id: str, name: str, data: bytes) -> None:
        if name not in FILE_NAMES:
            raise ValueError(f"unexpected output file name: {name!r}")
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"{name} is larger than 20 MB")
        kind = "audio/mpeg" if name.endswith(".mp3") else "application/json"
        self._ok_retrying("PUT", f"{self._job(job_id)}/files/{name}", content=data, headers={"Content-Type": kind})

    def complete(self, job_id: str, output: dict) -> None:
        self._ok_retrying("POST", f"{self._job(job_id)}/complete", json=output)

    def fail(self, job_id: str, error: str) -> None:
        self._ok("POST", f"{self._job(job_id)}/fail", json={"error": error[:1000]})
