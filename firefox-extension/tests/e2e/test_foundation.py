"""Exercise production permissions, actual audio, and visible source highlights."""

import time

from harness import TEXT, TOKEN, Reader, activate_reader


def test_installed_extension_audio_and_highlight(configured, server, tmp_path):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)
    assert reader.state() == "ready"
    started = time.monotonic()
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == "Fixture article"
    assert server.requests == [
        {
            "model": "kokoro",
            "input": "Fixture article",
            "voice": "af_heart",
            "speed": 1,
            "response_format": "wav",
        }
    ]
    assert TOKEN not in driver.page_source
    driver.save_screenshot(str(tmp_path / "speaking.png"))
    reader.wait.until(lambda _: reader.highlight() == TEXT)
    assert server.requests[1]["input"] == TEXT
    driver.save_screenshot(str(tmp_path / "paragraph-speaking.png"))
    reader.wait.until(lambda _: reader.highlight() == "Another paragraph.")
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [
        "Fixture article",
        TEXT,
        "Another paragraph.",
    ]
    assert time.monotonic() - started >= 5.4
    assert reader.highlight() == ""
    print(
        f'Firefox {driver.capabilities["browserVersion"]}: toolbar activation, authenticated WAV, audio completion, and CSS highlight passed'
    )
