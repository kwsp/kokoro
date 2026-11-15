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
    assert reader.highlight() == TEXT
    assert server.requests == [
        {
            "model": "kokoro",
            "input": TEXT,
            "voice": "af_heart",
            "speed": 1,
            "response_format": "wav",
        }
    ]
    assert TOKEN not in driver.page_source
    driver.save_screenshot(str(tmp_path / "speaking.png"))
    reader.wait_state("finished")
    assert time.monotonic() - started >= 1.8
    assert reader.highlight() == ""
    print(
        f'Firefox {driver.capabilities["browserVersion"]}: toolbar activation, authenticated WAV, audio completion, and CSS highlight passed'
    )
