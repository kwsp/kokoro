"""Use fresh Firefox profiles and local fixtures, never the user's browser data."""

import json
import os
import subprocess
import zipfile
from contextlib import suppress

import pytest
from harness import EXTENSION, FixtureServer, configure
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service


@pytest.fixture
def server(tmp_path):
    fixture = FixtureServer()
    try:
        yield fixture
    finally:
        fixture.close()
        (tmp_path / "server-history.json").write_text(
            json.dumps(
                {"history": fixture.history, "requests": fixture.requests}, indent=2
            )
        )


@pytest.fixture
def firefox(tmp_path, request):
    options = Options()
    options.binary_location = os.environ.get(
        "FIREFOX_BINARY", "/Applications/Firefox.app/Contents/MacOS/firefox"
    )
    if os.environ.get("FIREFOX_HEADED") != "1":
        options.add_argument("-headless")
    options.set_preference("network.dns.localDomains", "reader.test")
    options.set_preference("network.proxy.type", 0)
    extension_dir = EXTENSION / "dist"
    if getattr(request, "param", {}).get("highlight_fallback"):
        extension_dir = tmp_path / "fallback-dist"
        subprocess.run(
            ["node", "scripts/build.mjs"],
            cwd=EXTENSION,
            env={
                **os.environ,
                "KOKORO_EXTENSION_OUT_DIR": str(extension_dir),
                "KOKORO_TEST_HIGHLIGHT_FALLBACK": "1",
            },
            check=True,
            capture_output=True,
            text=True,
        )
    bundle = tmp_path / "reader.xpi"
    with zipfile.ZipFile(bundle, "w") as archive:
        for file in extension_dir.iterdir():
            archive.write(file, file.name)
    home = tmp_path / "firefox-home"
    home.mkdir()
    service = Service(
        executable_path=os.environ.get("GECKODRIVER"),
        service_args=["--allow-system-access"],
        env={**os.environ, "CFFIXED_USER_HOME": str(home)},
        log_output=str(tmp_path / "geckodriver.log"),
    )
    driver = webdriver.Firefox(options=options, service=service)
    try:
        driver.set_window_size(1100, 850)
        driver.install_web_extension(str(bundle), permanent=False)
        yield driver
    finally:
        with suppress(WebDriverException):
            driver.save_screenshot(str(tmp_path / "final.png"))
            state = driver.execute_script(
                """const host = document.getElementById('kokoro-reader-controls');
                return host ? {state: host.dataset.state, sentence: host.dataset.sentence,
                    status: host.shadowRoot.querySelector('[role=status]').textContent} : null;"""
            )
            (tmp_path / "reader-state.json").write_text(json.dumps(state, indent=2))
            with driver.context(driver.CONTEXT_CHROME):
                controls = driver.execute_script(
                    """return Array.from(document.querySelectorAll('[id*="kokoro"], [id*="extensions"]'),
                    element => ({id: element.id, label: element.getAttribute('label'), extension: element.getAttribute('data-extensionid')}));"""
                )
            (tmp_path / "browser-controls.json").write_text(
                json.dumps(controls, indent=2)
            )
        driver.quit()


@pytest.fixture
def configured(firefox, server):
    configure(firefox, server)
    return firefox
