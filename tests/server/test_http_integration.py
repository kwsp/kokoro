"""Exercise HTTP framing and disconnects through Uvicorn, not an ASGI transport."""

import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import wave
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
import uvicorn
from openai import OpenAI

from kokoro_server.app import create_app
from kokoro_server.engine import KokoroEngine

TOKEN = "integration-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
INPUT = {"model": "kokoro", "voice": "af_heart", "input": "Hello."}
PCM = b"\x01\x00\xff\x7f" * 1024


class Engine:
    def __init__(self, generate=None):
        self.voices = {"af_heart": "a"}
        self.generate = generate or (lambda: iter([PCM, PCM]))
        self.closed = threading.Event()

    def warmup(self):
        pass

    def synthesize(self, request):
        try:
            yield from self.generate()
        finally:
            self.closed.set()


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            pytest.fail("Timed out waiting for server state")
        time.sleep(0.01)


@contextmanager
def running_server(engine=None, *, engine_factory=None):
    app = create_app(TOKEN, engine_factory=engine_factory or (lambda: engine))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="critical", access_log=False, ws="none")
    )
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]})
    thread.start()
    try:
        wait_for(lambda: server.started, timeout=120 if engine_factory else 5)
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5) as client:
            yield SimpleNamespace(client=client, app=app, port=port)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
        assert not thread.is_alive(), "Uvicorn failed to shut down"


def test_pcm_arrives_before_generation_finishes_and_health_remains_responsive():
    entered, release = threading.Event(), threading.Event()

    def generate():
        yield PCM
        entered.set()
        assert release.wait(5)
        yield PCM

    with running_server(Engine(generate)) as live:
        try:
            with live.client.stream(
                "POST",
                "/v1/audio/speech",
                headers=AUTH,
                json={**INPUT, "response_format": "pcm"},
            ) as response:
                assert response.status_code == 200
                assert response.headers["transfer-encoding"] == "chunked"
                blocks = response.iter_bytes()
                first = next(blocks)
                assert PCM.startswith(first)
                assert entered.wait(2)
                assert live.client.get("/health").status_code == 200
                busy = live.client.post("/v1/audio/speech", headers=AUTH, json=INPUT)
                assert busy.status_code == 429
                assert busy.headers["retry-after"] == "1"
                release.set()
                assert first + b"".join(blocks) == PCM * 2
        finally:
            release.set()


@pytest.mark.parametrize("after_first", [False, True])
def test_disconnect_retains_slot_until_inference_finishes(after_first):
    entered, release = threading.Event(), threading.Event()
    finished = threading.Event()

    def generate():
        if after_first:
            yield PCM
        entered.set()
        assert release.wait(5)
        yield PCM
        finished.set()

    engine = Engine(generate)
    with running_server(engine) as live:
        client_socket = socket.create_connection(("127.0.0.1", live.port), timeout=5)
        body = json.dumps({**INPUT, "response_format": "pcm"}).encode()
        request = (
            "POST /v1/audio/speech HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{live.port}\r\n"
            f"Authorization: Bearer {TOKEN}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n\r\n"
        ).encode() + body
        try:
            client_socket.sendall(request)
            assert entered.wait(2)
            client_socket.close()
            wait_for(lambda: live.app.state.speech._active._cancelled.is_set())
            assert live.app.state.speech.busy
            assert live.client.get("/health").status_code == 200
            release.set()
            assert engine.closed.wait(2)
            wait_for(lambda: not live.app.state.speech.busy)
            assert not finished.is_set()
        finally:
            client_socket.close()
            release.set()


def test_midstream_failure_is_an_incomplete_http_response():
    def generate():
        yield PCM
        raise RuntimeError("private engine details")

    with running_server(Engine(generate)) as live:
        with live.client.stream(
            "POST",
            "/v1/audio/speech",
            headers=AUTH,
            json={**INPUT, "response_format": "pcm"},
        ) as response:
            assert response.status_code == 200
            data = bytearray()
            with pytest.raises(httpx.RemoteProtocolError):
                for chunk in response.iter_bytes():
                    data.extend(chunk)
            assert bytes(data) == PCM
        wait_for(lambda: not live.app.state.speech.busy)


@pytest.mark.parametrize("response_format", ["pcm", "wav"])
def test_openai_sdk_reads_explicit_audio_formats(response_format):
    with running_server(Engine()) as live:
        with OpenAI(
            base_url=f"http://127.0.0.1:{live.port}/v1",
            api_key=TOKEN,
            max_retries=0,
            timeout=5,
        ) as client:
            with client.audio.speech.with_streaming_response.create(
                **INPUT,
                response_format=response_format,
            ) as response:
                data = b"".join(response.iter_bytes())
        if response_format == "wav":
            with wave.open(io.BytesIO(data), "rb") as reader:
                assert (
                    reader.getframerate(),
                    reader.getnchannels(),
                    reader.getsampwidth(),
                ) == (24000, 1, 2)
                assert reader.readframes(reader.getnframes()) == PCM * 2
        else:
            assert data == PCM * 2


@pytest.mark.skipif(
    os.environ.get("KOKORO_TEST_REAL_MODEL") != "1",
    reason="Set KOKORO_TEST_REAL_MODEL=1 to exercise the cached model",
)
def test_real_cached_model_over_http(tmp_path):
    start = time.perf_counter()
    with running_server(engine_factory=lambda: KokoroEngine(device="cpu")) as live:
        print(f"Model startup including warmup: {time.perf_counter() - start:.2f}s")
        voices = live.client.get("/v1/voices", headers=AUTH).json()["voices"]
        assert any(voice["id"] == "af_heart" for voice in voices)
        engine = live.app.state.speech._engine
        assert engine.model.device.type == "cpu"
        assert live.client.get("/health").json()["device"] == "cpu"
        for response_format in ("wav", "pcm"):
            start = time.perf_counter()
            result = live.client.post(
                "/v1/audio/speech",
                headers=AUTH,
                json={
                    **INPUT,
                    "input": "Hello from the local speech server.",
                    "response_format": response_format,
                },
            )
            result.raise_for_status()
            data = result.content
            (tmp_path / f"speech.{response_format}").write_bytes(data)
            if response_format == "wav":
                with wave.open(io.BytesIO(data), "rb") as reader:
                    assert (
                        reader.getframerate(),
                        reader.getnchannels(),
                        reader.getsampwidth(),
                    ) == (24000, 1, 2)
                    data = reader.readframes(reader.getnframes())
            samples = np.frombuffer(data, dtype="<i2")
            assert len(samples) > 24000
            assert np.max(np.abs(samples.astype(np.int32))) > 100
            assert live.app.state.speech._engine is engine
            print(
                f"{response_format}: {len(samples)/24000:.2f}s audio in {time.perf_counter()-start:.2f}s"
            )


@pytest.mark.skipif(
    os.environ.get("KOKORO_TEST_MPS") != "1",
    reason="Set KOKORO_TEST_MPS=1 on an Apple Silicon host with GPU access",
)
def test_real_mps_model_over_http():
    start = time.perf_counter()
    with running_server(engine_factory=KokoroEngine) as live:
        engine = live.app.state.speech._engine
        assert engine.device == "mps"
        assert engine.model.device.type == "mps"
        assert live.client.get("/health").json()["device"] == "mps"
        print(f"MPS startup including warmup: {time.perf_counter() - start:.2f}s")
        for response_format in ("wav", "pcm", "wav", "pcm"):
            start = time.perf_counter()
            response = live.client.post(
                "/v1/audio/speech",
                headers=AUTH,
                json={
                    **INPUT,
                    "input": "Hello from the local speech server.",
                    "response_format": response_format,
                },
            )
            response.raise_for_status()
            data = response.content
            if response_format == "wav":
                with wave.open(io.BytesIO(data), "rb") as reader:
                    assert (
                        reader.getframerate(),
                        reader.getnchannels(),
                        reader.getsampwidth(),
                    ) == (24000, 1, 2)
                    data = reader.readframes(reader.getnframes())
            samples = np.frombuffer(data, dtype="<i2")
            assert np.isfinite(samples).all()
            assert (
                len(samples) > 24000 and np.max(np.abs(samples.astype(np.int32))) > 100
            )
            assert live.app.state.speech._engine is engine
            assert engine.model.device.type == "mps"
            print(
                f"MPS {response_format}: {len(samples)/24000:.2f}s audio in {time.perf_counter()-start:.2f}s"
            )


@pytest.mark.skipif(
    os.environ.get("KOKORO_TEST_MPS") != "1",
    reason="Set KOKORO_TEST_MPS=1 on an Apple Silicon host with GPU access",
)
def test_cli_auto_enables_mps_without_fallback_environment(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    environment = os.environ.copy()
    environment["KOKORO_API_KEY"] = TOKEN
    environment.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
    with (tmp_path / "cli.log").open("w+") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "kokoro_server", "--port", str(port)],
            env=environment,
            stdout=log,
            stderr=log,
        )
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5) as client:

                def ready():
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(f"CLI exited before readiness: {log.read()}")
                    try:
                        return client.get("/health").status_code == 200
                    except httpx.ConnectError:
                        return False

                wait_for(ready, timeout=120)
                assert client.get("/health").json()["device"] == "mps"
                response = client.post(
                    "/v1/audio/speech",
                    headers=AUTH,
                    json={**INPUT, "response_format": "pcm"},
                )
                response.raise_for_status()
                samples = np.frombuffer(response.content, dtype="<i2")
                assert len(samples) and np.max(np.abs(samples.astype(np.int32))) > 100
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
