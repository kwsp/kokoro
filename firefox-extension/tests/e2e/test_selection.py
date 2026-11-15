"""Read exact selections through real browser entry points and controls."""

from harness import (
    Reader,
    activate_reader,
    activate_selection_menu,
    activate_shortcut,
    select_contents,
)
from selenium.webdriver.common.by import By

SENTENCES = ["Read this 😀 sentence.", "Next selected sentence."]


def selection_page(driver, server):
    driver.get(f"http://reader.test:{server.port}/selection")
    select_contents(driver, "selected")


def test_context_menu_selection_and_reactivation(configured, server, tmp_path):
    driver = configured
    selection_page(driver, server)
    activate_selection_menu(driver, driver.find_element(By.ID, "selected"))
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == SENTENCES[0]
    driver.save_screenshot(str(tmp_path / "selection-speaking.png"))
    reader.wait.until(lambda _: reader.highlight() == SENTENCES[1])
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == SENTENCES
    assert reader.highlight() == ""
    select_contents(driver, "replacement")
    activate_selection_menu(driver, driver.find_element(By.ID, "replacement"))
    assert len(driver.find_elements(By.ID, "kokoro-reader-controls")) == 1
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == "Replacement text only."
    assert any(
        request["input"] == "Replacement text only." for request in server.requests
    )
    reader.click("stop")


def test_shortcut_pause_resume_and_stop(configured, server, tmp_path):
    driver = configured
    selection_page(driver, server)
    activate_shortcut(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    reader.click("play")
    reader.wait_state("paused")
    assert reader.highlight() == ""
    assert reader.highlight("kokoro-paused") == SENTENCES[0]
    driver.save_screenshot(str(tmp_path / "selection-paused.png"))
    reader.remains("paused", 2.2)
    assert sum(request["input"] == SENTENCES[0] for request in server.requests) == 1
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == SENTENCES[0]
    assert sum(request["input"] == SENTENCES[0] for request in server.requests) == 1
    reader.click("stop")
    reader.remains("ready", 2.2)
    assert reader.highlight() == ""
    assert reader.highlight("kokoro-paused") == ""
    assert sum(request["input"] == SENTENCES[0] for request in server.requests) == 1
    reader.click("close")
    assert driver.find_elements(By.ID, "kokoro-reader-controls") == []


def test_stop_discards_delayed_response(configured, server):
    driver = configured
    selection_page(driver, server)
    gate = server.queue(delayed=True)
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait.until(lambda _: len(server.requests) >= 1)
    assert reader.state() == "preparing"
    reader.click("stop")
    gate.set()
    reader.remains("ready", 0.8)
    assert reader.highlight() == ""
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == SENTENCES[0]
    assert [request["input"] for request in server.requests].count(SENTENCES[0]) == 2
    reader.click("stop")


def test_malformed_wav_has_recoverable_retry(configured, server):
    driver = configured
    selection_page(driver, server)
    server.queue(body=b"invalid WAV")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("error")
    assert (
        "invalid WAV"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert reader.host.shadow_root.find_element(By.ID, "play").text == "Retry"
    assert reader.highlight() == ""
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == SENTENCES[0]
    assert [request["input"] for request in server.requests].count(SENTENCES[0]) == 2
    reader.click("stop")
