"""Install the production bundle in Firefox and exercise its first reading path."""

import io
import json
import math
import os
import struct
import threading
import time
import wave
import zipfile
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

EXTENSION = Path(__file__).resolve().parents[2]
TOKEN = "fixture-secret"
TEXT = "Kokoro reads this first paragraph."


def tone():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(
            b"".join(
                struct.pack("<h", int(2000 * math.sin(2 * math.pi * 440 * n / 24000)))
                for n in range(48000)
            )
        )
    return output.getvalue()


@pytest.fixture
def server(tmp_path):
    requests = []
    history = []
    wav = tone()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body, content_type):
            history.append(
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
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/article":
                self.send(
                    200,
                    f'<!doctype html><html><head><meta charset="utf-8"><title>Reading fixture</title></head><body><nav>Navigation must not be read.</nav><article><h1>Fixture article</h1><p id="first">{TEXT}</p><p>Another paragraph.</p></article></body></html>'.encode(),
                    "text/html",
                )
            elif self.path == "/v1/voices":
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self.send(401, b"{}", "application/json")
                else:
                    self.send(
                        200,
                        json.dumps(
                            {"voices": [{"id": "af_heart", "language": "a"}]}
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
            requests.append(value)
            self.send(200, wav, "audio/wav")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_port, requests
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)
        (tmp_path / "server-history.json").write_text(json.dumps(history, indent=2))


@pytest.fixture
def firefox(tmp_path):
    options = Options()
    options.binary_location = os.environ.get(
        "FIREFOX_BINARY", "/Applications/Firefox.app/Contents/MacOS/firefox"
    )
    if os.environ.get("FIREFOX_HEADED") != "1":
        options.add_argument("-headless")
    options.set_preference("network.dns.localDomains", "reader.test")
    options.set_preference("network.proxy.type", 0)
    home = tmp_path / "firefox-home"
    home.mkdir()
    service = Service(
        executable_path=os.environ.get("GECKODRIVER"),
        service_args=["--allow-system-access"],
        env={**os.environ, "CFFIXED_USER_HOME": str(home)},
        log_output=str(tmp_path / "geckodriver.log"),
    )
    driver = webdriver.Firefox(options=options, service=service)
    driver.set_window_size(1100, 850)
    bundle = tmp_path / "reader.xpi"
    with zipfile.ZipFile(bundle, "w") as archive:
        for file in (EXTENSION / "dist").iterdir():
            archive.write(file, file.name)
    driver.install_web_extension(str(bundle), permanent=False)
    try:
        yield driver
    finally:
        # Keep artifacts on failures without dumping options HTML or credentials.
        with suppress(WebDriverException):
            driver.save_screenshot(str(tmp_path / "final.png"))
            with driver.context(driver.CONTEXT_CHROME):
                controls = driver.execute_script(
                    """return Array.from(document.querySelectorAll('[id*="kokoro"], [id*="extensions"]'),
                        element => ({id: element.id, label: element.getAttribute('label'),
                            extension: element.getAttribute('data-extensionid')}));"""
                )
            (tmp_path / "browser-controls.json").write_text(
                json.dumps(controls, indent=2)
            )
        driver.quit()


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


def test_installed_extension_audio_and_highlight(firefox, server, tmp_path):
    port, requests = server
    wait = WebDriverWait(firefox, 15)

    def options_tab(driver):
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            if driver.current_url.startswith(
                "moz-extension://"
            ) and driver.current_url.endswith("/options.html"):
                return True
        return False

    wait.until(options_tab)
    wait.until(lambda d: d.find_element(By.ID, "base-url").get_attribute("value"))
    for identifier, value in [
        ("base-url", f"http://127.0.0.1:{port}"),
        ("token", TOKEN),
    ]:
        element = firefox.find_element(By.ID, identifier)
        element.clear()
        element.send_keys(value)
    firefox.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    wait.until(lambda d: d.find_element(By.ID, "status").text == "Settings saved.")
    firefox.find_element(By.ID, "test").click()
    wait.until(lambda d: "Connected." in d.find_element(By.ID, "status").text)

    firefox.get(f"http://reader.test:{port}/article")
    activate_reader(firefox)
    host = wait.until(lambda d: d.find_element(By.ID, "kokoro-reader-controls"))
    shadow = host.shadow_root
    assert host.get_attribute("data-state") == "ready"
    play = shadow.find_element(By.CSS_SELECTOR, "button")
    started = time.monotonic()
    play.click()
    wait.until(lambda _: host.get_attribute("data-state") == "playing")
    highlighted = firefox.execute_script(
        'return Array.from(CSS.highlights.get("kokoro-speaking") || [], r => r.toString()).join("")'
    )
    assert highlighted == TEXT
    assert requests == [
        {
            "model": "kokoro",
            "input": TEXT,
            "voice": "af_heart",
            "speed": 1,
            "response_format": "wav",
        }
    ]
    assert TOKEN not in firefox.page_source
    firefox.save_screenshot(str(tmp_path / "speaking.png"))
    wait.until(lambda _: host.get_attribute("data-state") == "finished")
    assert time.monotonic() - started >= 1.8
    assert (
        firefox.execute_script('return CSS.highlights.has("kokoro-speaking")') is False
    )
    print(
        f'Firefox {firefox.capabilities["browserVersion"]}: installed MV2, toolbar activation, authenticated WAV, binary messaging, audio end event, and CSS highlight passed'
    )
