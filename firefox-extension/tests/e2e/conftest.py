"""Use fresh Firefox profiles and local fixtures, never the user's browser data."""

import json
import os
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
