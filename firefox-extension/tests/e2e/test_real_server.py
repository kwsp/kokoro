"""Opt-in installed-Firefox smoke tests against cached Kokoro on CPU and MPS."""

import json
import os
import platform
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from harness import (
    TOKEN,
    Reader,
    activate_reader,
    configure,
    observe_playback,
    preparation_gaps,
)
from selenium.webdriver import ActionChains
from selenium.webdriver.support.ui import WebDriverWait

REPOSITORY = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(
    os.environ.get("KOKORO_TEST_REAL_EXTENSION") != "1",
    reason="Set KOKORO_TEST_REAL_EXTENSION=1 with cached model and language resources",
)


@dataclass
class LiveKokoro:
    port: int
    device: str
    client: httpx.Client
    process: subprocess.Popen[str]


@pytest.fixture(params=["cpu", "auto"])
def live_kokoro(request, tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    environment = {
        **os.environ,
        "KOKORO_API_KEY": TOKEN,
        "HF_HUB_OFFLINE": "1",
    }
    # The server must enable its own supported MPS fallback before importing Torch.
    environment.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
    log_path = tmp_path / f"kokoro-{request.param}.log"
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "kokoro_server",
                "--device",
                request.param,
                "--port",
                str(port),
            ],
            cwd=REPOSITORY,
            env=environment,
            stdout=log,
            stderr=log,
            text=True,
        )
        try:
            with httpx.Client(
                base_url=f"http://127.0.0.1:{port}", timeout=2, trust_env=False
            ) as client:

                def ready(_):
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(f"Kokoro exited during startup:\n{log.read()}")
                    try:
                        response = client.get("/health")
                        return response.json() if response.status_code == 200 else False
                    except httpx.HTTPError:
                        return False

                health = WebDriverWait(client, 120, poll_frequency=0.2).until(ready)
                apple_silicon = sys.platform == "darwin" and platform.machine() in {
                    "arm64",
                    "aarch64",
                }
                expected = "mps" if request.param == "auto" and apple_silicon else "cpu"
                assert health["device"] == expected
                yield LiveKokoro(port, expected, client, process)
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def test_cached_kokoro_read_pause_seek_and_finish(
    live_kokoro, firefox, server, tmp_path
):
    """Exercise real WAV generation and browser playback without a test audio hook."""
    configure(firefox, live_kokoro)
    firefox.get(f"http://reader.test:{server.port}/mouse")
    activate_reader(firefox)
    reader = Reader(firefox)
    reader.wait = WebDriverWait(firefox, 90, poll_frequency=0.1)
    started = time.monotonic()
    reader.click("play")
    reader.wait_state("playing")
    first_audio = time.monotonic() - started
    assert reader.highlight()
    reader.click("play")
    reader.wait_state("paused")
    reader.remains("paused", 0.3)
    reader.click("play")
    reader.wait_state("playing")

    reader.click("click-mode")
    point = firefox.execute_script("""const range = document.createRange();
        range.selectNodeContents(document.getElementById('last-words'));
        const rect = Array.from(range.getClientRects()).find(r => r.width && r.height);
        return {x: Math.round(rect.left + Math.min(8, rect.width / 2)),
                y: Math.round(rect.top + rect.height / 2)};""")
    action = ActionChains(firefox)
    action.w3c_actions.pointer_action.move_to_location(point["x"], point["y"])
    action.click().perform()
    reader.wait.until(lambda _: reader.highlight() == "Last sentence starts here.")
    firefox.save_screenshot(str(tmp_path / f"real-{live_kokoro.device}-speaking.png"))
    reader.wait_state("finished")
    assert reader.highlight() == ""
    assert server.requests == []  # Audio must come from Kokoro, not the fixture server.
    assert live_kokoro.process.poll() is None
    assert live_kokoro.client.get("/health").json()["device"] == live_kokoro.device
    print(
        f"Real Kokoro {live_kokoro.device}: first audio in {first_audio:.2f}s; "
        "installed Firefox read, pause/resume, click seek, and completion passed"
    )


def test_cached_kokoro_short_replies(live_kokoro, firefox, server, tmp_path):
    """Measure real sentence preparation stalls; hardware speed is not a pass condition."""
    configure(firefox, live_kokoro)
    firefox.get(f"http://reader.test:{server.port}/short-sentences")
    activate_reader(firefox)
    reader = Reader(firefox)
    reader.wait = WebDriverWait(firefox, 120, poll_frequency=0.1)
    observe_playback(firefox)
    reader.click("play")
    reader.wait_state("playing")
    reader.wait_state("finished")
    transitions = firefox.execute_script("return window.readerTransitions")
    (tmp_path / "transitions.json").write_text(json.dumps(transitions, indent=2))
    spoken = [item["sentence"] for item in transitions if item["state"] == "playing"]
    assert spoken == [str(index) for index in range(1, 9)]
    assert reader.highlight() == ""
    assert server.requests == []
    assert live_kokoro.process.poll() is None
    gaps = preparation_gaps(transitions)
    print(
        f"Real Kokoro {live_kokoro.device}: 8 short replies; "
        f"preparation gaps ms: {gaps}; total {sum(gaps):.0f}ms"
    )
