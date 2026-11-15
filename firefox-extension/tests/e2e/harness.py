"""Real installed-extension fixtures and browser-chrome interactions."""

import io
import json
import math
import struct
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

EXTENSION = Path(__file__).resolve().parents[2]
TOKEN = "fixture-secret"
TEXT = "Kokoro reads this first paragraph."


def tone(seconds=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(
            b"".join(
                struct.pack("<h", int(2000 * math.sin(2 * math.pi * 440 * n / 24000)))
                for n in range(int(seconds * 24000))
            )
        )
    return output.getvalue()


@dataclass
class Reply:
    body: bytes | None = None
    status: int = 200
    gate: threading.Event | None = None
    retry_after: str | None = None


class FixtureServer:
    def __init__(self):
        self.requests = []
        self.history = []
        self.replies = deque()
        self.gates = []
        wav = tone()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, status, body, content_type, retry_after=None):
                owner.history.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "status": status,
                        "authenticated": self.headers.get("Authorization")
                        == f"Bearer {TOKEN}",
                    }
                )
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                if retry_after is not None:
                    self.send_header("Retry-After", retry_after)
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Cancellation is part of the behavior under test.

            def do_GET(self):
                if self.path in {
                    "/article",
                    "/selection",
                    "/readability",
                    "/ambiguous",
                    "/empty",
                    "/mouse",
                    "/web-app",
                    "/editable-document",
                    "/short-sentences",
                }:
                    fixture = EXTENSION / "tests" / "fixtures" / f"{self.path[1:]}.html"
                    self.send(200, fixture.read_bytes(), "text/html")
                elif self.path == "/v1/voices":
                    if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                        self.send(401, b"{}", "application/json")
                    else:
                        self.send(
                            200,
                            json.dumps(
                                {
                                    "voices": [
                                        {"id": "af_heart", "language": "a"},
                                        {"id": "af_bella", "language": "a"},
                                    ]
                                }
                            ).encode(),
                            "application/json",
                        )
                else:
                    self.send(404, b"not found", "text/plain")

            def do_POST(self):
                if (
                    self.path != "/v1/audio/speech"
                    or self.headers.get("Authorization") != f"Bearer {TOKEN}"
                ):
                    self.send(401, b"{}", "application/json")
                    return
                value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(value)
                reply = owner.replies.popleft() if owner.replies else Reply()
                if reply.gate and not reply.gate.wait(timeout=15):
                    self.send(504, b"gate timed out", "text/plain")
                    return
                self.send(
                    reply.status,
                    wav if reply.body is None else reply.body,
                    "audio/wav",
                    reply.retry_after,
                )

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def queue(self, *, body=None, status=200, delayed=False, retry_after=None):
        gate = threading.Event() if delayed else None
        if gate:
            self.gates.append(gate)
        self.replies.append(Reply(body, status, gate, retry_after))
        return gate

    def close(self):
        for gate in self.gates:
            gate.set()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def configure(driver, server):
    wait = WebDriverWait(driver, 15)

    def options_tab(browser):
        for handle in browser.window_handles:
            browser.switch_to.window(handle)
            if browser.current_url.startswith(
                "moz-extension://"
            ) and browser.current_url.endswith("/options.html"):
                return True
        return False

    wait.until(options_tab)
    wait.until(lambda d: d.find_element(By.ID, "base-url").get_attribute("value"))
    for identifier, value in [
        ("base-url", f"http://127.0.0.1:{server.port}"),
        ("token", TOKEN),
    ]:
        element = driver.find_element(By.ID, identifier)
        element.clear()
        element.send_keys(value)
    driver.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    wait.until(lambda d: d.find_element(By.ID, "status").text == "Settings saved.")
    driver.find_element(By.ID, "test").click()
    wait.until(lambda d: "Connected." in d.find_element(By.ID, "status").text)


def activate_reader(driver):
    """Click the installed extension's real browser action, granting activeTab."""
    with driver.context(driver.CONTEXT_CHROME):
        driver.find_element(By.ID, "unified-extensions-button").click()
        action = WebDriverWait(driver, 15).until(
            lambda d: d.find_element(
                By.CSS_SELECTOR,
                '.unified-extensions-item-action-button[data-extensionid="kokoro-reader@local.invalid"]',
            )
        )
        action.click()


def activate_shortcut(driver):
    with driver.context(driver.CONTEXT_CHROME):
        ActionChains(driver).key_down(Keys.ALT).key_down(Keys.SHIFT).send_keys(
            "K"
        ).key_up(Keys.SHIFT).key_up(Keys.ALT).perform()


def activate_selection_menu(driver, element):
    ActionChains(driver).context_click(element).perform()
    with driver.context(driver.CONTEXT_CHROME):
        WebDriverWait(driver, 15).until(
            lambda d: d.find_element(
                By.CSS_SELECTOR, 'menuitem[label="Read selection with Kokoro"]'
            )
        ).click()
        # WebDriver triggers the action but leaves Firefox's native popup open on
        # macOS. Dismiss it after the real click without bypassing activation.
        driver.execute_script(
            "document.getElementById('contentAreaContextMenu').hidePopup()"
        )
        WebDriverWait(driver, 15).until(
            lambda d: d.execute_script(
                "return document.getElementById('contentAreaContextMenu').state === 'closed'"
            )
        )


def select_contents(driver, identifier):
    driver.execute_script(
        """const range = document.createRange();
        range.selectNodeContents(document.getElementById(arguments[0]));
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);""",
        identifier,
    )


def observe_playback(driver):
    """Record public UI transitions without changing the extension or its audio."""
    driver.execute_script(
        """const host = document.getElementById('kokoro-reader-controls');
        window.readerTransitions = [];
        new MutationObserver(() => window.readerTransitions.push({
            time: performance.now(), state: host.dataset.state,
            sentence: host.dataset.sentence,
            status: host.shadowRoot.querySelector('[role=status]').textContent
        })).observe(host, {attributes: true, attributeFilter: ['data-state', 'data-sentence']});"""
    )


def preparation_gaps(transitions):
    gaps = []
    preparing_at = None
    began = False
    for transition in transitions:
        if transition["state"] == "playing":
            if began and preparing_at is not None:
                gaps.append(transition["time"] - preparing_at)
            preparing_at = None
            began = True
        elif began and transition["state"] == "preparing":
            preparing_at = transition["time"]
    return gaps


class Reader:
    def __init__(self, driver):
        self.driver = driver
        self.wait = WebDriverWait(driver, 15, poll_frequency=0.1)
        self.host = self.wait.until(
            lambda d: d.find_element(By.ID, "kokoro-reader-controls")
        )

    def state(self):
        return self.host.get_attribute("data-state")

    def wait_state(self, state):
        self.wait.until(lambda _: self.state() == state)

    def click(self, identifier):
        self.host.shadow_root.find_element(By.ID, identifier).click()

    def highlight(self, name="kokoro-speaking"):
        return self.driver.execute_script(
            'return Array.from(CSS.highlights.get(arguments[0]) || [], r => r.toString()).join("")',
            name,
        )

    def remains(self, state, seconds):
        """Observe the state for a bounded interval, failing on any transition."""
        started = time.monotonic()

        def unchanged(_):
            assert self.state() == state
            return time.monotonic() - started >= seconds

        self.wait.until(unchanged)
