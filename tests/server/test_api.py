import asyncio
import io
import json
import threading
import wave
from typing import ClassVar

import httpx
import pytest
from fastapi.testclient import TestClient

from kokoro_server.app import create_app

TOKEN = "local-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
INPUT = {"model": "kokoro", "input": "Hello.", "voice": "af_heart"}
PCM = b"\x01\x00\xff\x7f" * 4


class Engine:
    device = "cpu"
    voices: ClassVar = {"af_heart": "a", "bf_emma": "b"}

    def __init__(self, generate=None):
        self.generate = generate or (lambda request: iter([PCM, PCM]))
        self.closed = threading.Event()
        self.calls = 0
        self.warmups = 0

    def warmup(self):
        self.warmups += 1

    def synthesize(self, request):
        self.calls += 1
        try:
            yield from self.generate(request)
        finally:
            self.closed.set()


@pytest.fixture
def client():
    engine = Engine()
    app = create_app(TOKEN, engine_factory=lambda: engine)
    with TestClient(app, base_url="http://localhost") as value:
        yield value, engine


def test_health_discovery_and_startup_reuse(client):
    client, engine = client
    assert client.get("/health").json() == {"status": "ready", "device": "cpu"}
    assert client.get("/v1/models", headers=AUTH).json()["data"][0]["id"] == "kokoro"
    voices = client.get("/v1/voices", headers=AUTH).json()
    assert voices["voices"] == [
        {"id": "af_heart", "language": "a"},
        {"id": "bf_emma", "language": "b"},
    ]
    for _ in range(2):
        assert (
            client.post("/v1/audio/speech", headers=AUTH, json=INPUT).status_code == 200
        )
    assert engine.warmups == 1 and engine.calls == 2


@pytest.mark.parametrize("path", ["/v1/models", "/v1/voices", "/v1/audio/speech"])
@pytest.mark.parametrize(
    "authorization", [None, "Bearer wrong", "Basic local-test-token"]
)
def test_authentication(client, path, authorization):
    client, engine = client
    headers = {} if authorization is None else {"Authorization": authorization}
    result = client.request(
        "POST" if path.endswith("speech") else "GET", path, headers=headers, json=INPUT
    )
    assert result.status_code == 401
    assert result.headers["www-authenticate"] == "Bearer"
    assert result.json()["error"]["code"] == "invalid_api_key"
    assert engine.calls == 0


def test_wav_and_pcm_bytes_headers(client):
    client, engine = client
    wav = client.post("/v1/audio/speech", headers=AUTH, json=INPUT)
    assert wav.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(wav.content), "rb") as reader:
        assert (
            reader.getframerate(),
            reader.getnchannels(),
            reader.getsampwidth(),
        ) == (24000, 1, 2)
        assert reader.readframes(reader.getnframes()) == PCM * 2
    pcm = client.post(
        "/v1/audio/speech", headers=AUTH, json={**INPUT, "response_format": "pcm"}
    )
    assert pcm.content == PCM * 2
    assert pcm.headers["content-type"] == "application/octet-stream"
    assert "content-length" not in pcm.headers
    assert pcm.headers["cache-control"] == "no-store"
    assert pcm.headers["x-audio-encoding"] == "pcm_s16le"
    assert pcm.headers["x-sample-rate"] == "24000"
    assert pcm.headers["x-request-id"] != wav.headers["x-request-id"]
    assert engine.closed.is_set()


@pytest.mark.parametrize(
    "changes, param",
    [
        ({"model": "tts-1"}, "model"),
        ({"voice": "af_absent"}, "voice"),
        ({"input": " "}, "input"),
        ({"response_format": "mp3"}, "response_format"),
        ({"instructions": "whisper"}, "instructions"),
        ({"speed": True}, "speed"),
    ],
)
def test_invalid_request_envelope(client, changes, param):
    client, engine = client
    result = client.post("/v1/audio/speech", headers=AUTH, json={**INPUT, **changes})
    assert result.status_code == 400
    assert result.json()["error"]["param"] == param
    assert engine.calls == 0


def test_bad_json_media_type_and_host(client):
    client, _ = client
    result = client.post(
        "/v1/audio/speech",
        headers={**AUTH, "Content-Type": "application/json"},
        content=b"{",
    )
    assert result.status_code == 400
    assert result.json()["error"]["code"] == "invalid_request"
    assert (
        client.post("/v1/audio/speech", headers=AUTH, content=b"text").status_code
        == 415
    )
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 400


def test_body_limit_counts_received_bytes_without_content_length():
    app = create_app(TOKEN, engine_factory=Engine, max_body_bytes=100)
    with TestClient(app, base_url="http://localhost") as client:
        result = client.post(
            "/v1/audio/speech",
            headers={**AUTH, "Content-Type": "application/json"},
            content=iter([b" " * 60, b" " * 60]),
        )
        assert result.status_code == 413
        assert result.json()["error"]["code"] == "request_too_large"


@pytest.mark.parametrize(
    "mode,status,code",
    [
        ("empty", 400, "empty_audio"),
        ("failure", 500, "synthesis_error"),
        ("limit", 400, "audio_limit"),
    ],
)
def test_initial_generation_errors_are_json(mode, status, code):
    def generate(request):
        if mode == "failure":
            raise RuntimeError("secret text and path")
        if mode != "empty":
            yield PCM

    engine = Engine(generate)
    app = create_app(
        TOKEN,
        engine_factory=lambda: engine,
        service_options={"max_audio_bytes": 2} if mode == "limit" else {},
    )
    with TestClient(app, base_url="http://localhost") as client:
        response = client.post(
            "/v1/audio/speech", headers=AUTH, json={**INPUT, "response_format": "pcm"}
        )
        assert response.status_code == status
        assert response.json()["error"]["code"] == code
        assert "secret" not in response.text
        assert engine.closed.is_set()


@pytest.mark.asyncio
async def test_busy_response_and_health_while_inference_runs():
    entered, release = threading.Event(), threading.Event()

    def generate(request):
        entered.set()
        release.wait(5)
        yield PCM

    app = create_app(TOKEN, engine_factory=lambda: Engine(generate))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://localhost"
        ) as client,
    ):
        first = asyncio.create_task(
            client.post("/v1/audio/speech", headers=AUTH, json=INPUT)
        )
        try:
            while not entered.is_set():
                await asyncio.sleep(0.001)
            assert (await client.get("/health")).status_code == 200
            busy = await client.post("/v1/audio/speech", headers=AUTH, json=INPUT)
            assert busy.status_code == 429 and busy.headers["retry-after"] == "1"
        finally:
            release.set()
            assert (await first).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response_format, after_first", [("pcm", False), ("wav", True), ("pcm", True)]
)
async def test_disconnect_closes_job_before_first_or_during_output(
    response_format, after_first
):
    entered, release = threading.Event(), threading.Event()

    def generate(request):
        if after_first:
            yield PCM
        entered.set()
        release.wait(5)
        yield PCM
        pytest.fail("Disconnected request should not generate a further chunk")

    engine = Engine(generate)
    app = create_app(
        TOKEN, engine_factory=lambda: engine, service_options={"shutdown_timeout": 0.01}
    )
    incoming = asyncio.Queue()
    await incoming.put(
        {
            "type": "http.request",
            "body": json.dumps({**INPUT, "response_format": response_format}).encode(),
            "more_body": False,
        }
    )
    messages = []

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/audio/speech",
        "query_string": b"",
        "headers": [
            (b"host", b"localhost"),
            (b"content-type", b"application/json"),
            (b"authorization", f"Bearer {TOKEN}".encode()),
        ],
        "server": ("localhost", 8880),
        "client": ("127.0.0.1", 1234),
    }
    async with app.router.lifespan_context(app):
        task = asyncio.create_task(app(scope, incoming.get, send))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.001)
            await incoming.put({"type": "http.disconnect"})
            await asyncio.wait_for(task, 1)
            assert app.state.speech.busy
            release.set()
            while app.state.speech.busy:
                await asyncio.sleep(0.001)
            assert engine.closed.is_set()
            if response_format == "pcm" and after_first:
                assert any(m.get("body") == PCM for m in messages)
                assert not any(
                    m["type"] == "http.response.body" and not m.get("more_body", False)
                    for m in messages
                )
        finally:
            release.set()
            await task


def test_midstream_failure_does_not_return_successful_audio():
    def generate(request):
        yield PCM
        raise RuntimeError("failed after first chunk")

    app = create_app(TOKEN, engine_factory=lambda: Engine(generate))
    with (
        TestClient(app, base_url="http://localhost") as client,
        pytest.raises(RuntimeError, match="Speech stream failed"),
    ):
        client.post(
            "/v1/audio/speech",
            headers=AUTH,
            json={**INPUT, "response_format": "pcm"},
        )


@pytest.mark.parametrize("key", [None, "", "   "])
def test_app_requires_key(key):
    with pytest.raises(ValueError):
        create_app(key)


def test_openapi_documents_authorization_and_binary_formats(client):
    client, _ = client
    spec = client.get("/openapi.json").json()
    route = spec["paths"]["/v1/audio/speech"]["post"]
    assert route["security"] == [{"HTTPBearer": []}]
    assert spec["components"]["securitySchemes"]["HTTPBearer"]["scheme"] == "bearer"
    assert set(route["responses"]["200"]["content"]) == {
        "audio/wav",
        "application/octet-stream",
    }
    assert (
        route["requestBody"]["content"]["application/json"]["schema"]["properties"][
            "response_format"
        ]["default"]
        == "wav"
    )


def test_no_permissive_cors(client):
    client, _ = client
    response = client.get("/health", headers={"Origin": "https://unrelated.example"})
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.asyncio
async def test_initial_timeout_returns_503_and_retains_busy_slot():
    release = threading.Event()

    def generate(request):
        release.wait(5)
        yield PCM

    app = create_app(
        TOKEN,
        engine_factory=lambda: Engine(generate),
        service_options={"operation_timeout": 0.01, "shutdown_timeout": 0.01},
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://localhost"
        ) as client,
    ):
        try:
            response = await client.post("/v1/audio/speech", headers=AUTH, json=INPUT)
            assert response.status_code == 503
            assert app.state.speech.busy
        finally:
            release.set()


def test_startup_failure_propagates_setup_instructions():
    from kokoro_server.engine import EngineSetupError

    def fail():
        raise EngineSetupError("Run hf download before startup")

    app = create_app(TOKEN, engine_factory=fail)
    with (
        pytest.raises(EngineSetupError, match="hf download"),
        TestClient(app, base_url="http://localhost"),
    ):
        pytest.fail("Startup should not serve requests after setup failure")
