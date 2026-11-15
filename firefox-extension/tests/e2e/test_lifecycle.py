"""Validate ownership, prefetch, source changes, settings, and recovery in Firefox."""

import time

from harness import TOKEN, Reader, activate_reader, select_contents, tone
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def open_reader(driver, server, path="article", selected=None):
    driver.get(f"http://reader.test:{server.port}/{path}")
    if selected:
        select_contents(driver, selected)
    activate_reader(driver)
    return Reader(driver)


def options_page(driver):
    def find(browser):
        for handle in browser.window_handles:
            browser.switch_to.window(handle)
            if browser.current_url.startswith(
                "moz-extension://"
            ) and browser.current_url.endswith("options.html"):
                return True
        return False

    WebDriverWait(driver, 10).until(find)


def save_field(driver, identifier, value):
    field = driver.find_element(By.ID, identifier)
    field.clear()
    field.send_keys(value)
    driver.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    WebDriverWait(driver, 10).until(
        lambda browser: browser.find_element(By.ID, "status").text == "Settings saved."
    )


def test_prefetch_waits_for_audio_clock_and_background_tab_continues(
    configured, server
):
    driver = configured
    server.queue(body=tone(3))
    server.queue(body=tone(8))
    reader = open_reader(driver, server)
    reading_tab = driver.current_window_handle
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: len(server.requests) == 3)
    assert reader.highlight() == "Fixture article"
    assert [request["input"] for request in server.requests] == [
        "Fixture article",
        "Kokoro reads this first paragraph.",
        "Another paragraph.",
    ]
    driver.switch_to.new_window("tab")
    driver.get("about:blank")
    backgrounded_at = time.monotonic()
    reader.wait.until(lambda _: time.monotonic() - backgrounded_at >= 3.1)
    driver.switch_to.window(reading_tab)
    assert reader.highlight() == "Kokoro reads this first paragraph."
    reader.click("stop")
    count = len(server.requests)
    reader.remains("ready", 3.2)
    assert len(server.requests) == count
    assert reader.highlight() == ""


def test_new_tab_revokes_paused_cached_audio_and_close_releases_owner(
    configured, server
):
    driver = configured
    first = open_reader(driver, server, selected="first")
    first_tab = driver.current_window_handle
    first.click("play")
    first.wait_state("playing")
    first.click("play")
    first.wait_state("paused")
    driver.switch_to.new_window("tab")
    second = open_reader(driver, server, "selection", "replacement")
    second_tab = driver.current_window_handle
    second.click("play")
    second.wait_state("playing")
    driver.switch_to.window(first_tab)
    first.wait_state("ready")
    assert first.highlight("kokoro-paused") == ""
    first.click("play")
    first.wait_state("playing")
    driver.switch_to.window(second_tab)
    second.wait_state("ready")
    second.click("play")
    second.wait_state("playing")
    driver.close()
    driver.switch_to.window(first_tab)
    first.wait_state("ready")
    first.click("play")
    first.wait_state("playing")
    first.click("stop")


def test_page_replacement_stops_and_play_refreshes_the_article(configured, server):
    driver = configured
    server.queue(body=tone(5))
    reader = open_reader(driver, server)
    reader.click("play")
    reader.wait_state("playing")
    driver.execute_script(
        'document.getElementById("first").outerHTML = "<p id=first>Updated paragraph.</p>"'
    )
    reader.wait_state("error")
    assert (
        "Page changed"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert reader.highlight() == ""
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: reader.highlight() == "Updated paragraph.")
    assert any(request["input"] == "Updated paragraph." for request in server.requests)
    reader.click("stop")


def test_selection_reactivation_focuses_and_settings_refresh_paused_audio(
    configured, server
):
    driver = configured
    server.queue(body=tone(5))
    reader = open_reader(driver, server, selected="first")
    reading_tab = driver.current_window_handle
    reader.click("play")
    reader.wait_state("playing")
    activate_reader(driver)
    assert reader.state() == "playing"
    assert len(server.requests) == 1
    reader.click("play")
    reader.wait_state("paused")
    reader.click("settings")
    options_page(driver)
    save_field(driver, "speed", "1.5")
    driver.switch_to.window(reading_tab)
    reader.wait.until(lambda _: reader.highlight("kokoro-paused") == "")
    assert reader.state() == "paused"
    reader.click("play")
    reader.wait_state("playing")
    assert server.requests[-1]["speed"] == 1.5
    assert server.requests[-1]["input"] == "Kokoro reads this first paragraph."
    reader.click("stop")


def test_settings_restart_playing_audio_and_identical_save_preserves_it(
    configured, server
):
    driver = configured
    server.queue(body=tone(15))
    reader = open_reader(driver, server, selected="first")
    reading_tab = driver.current_window_handle
    reader.click("play")
    reader.wait_state("playing")
    reader.click("settings")
    options_page(driver)
    save_field(driver, "speed", "1")
    driver.switch_to.window(reading_tab)
    reader.remains("playing", 0.3)
    assert len(server.requests) == 1
    reader.click("settings")
    options_page(driver)
    server.queue(body=tone(5))
    save_field(driver, "speed", "1.5")
    driver.switch_to.window(reading_tab)
    reader.wait.until(lambda _: len(server.requests) == 2)
    reader.wait_state("playing")
    assert server.requests[-1]["speed"] == 1.5
    assert server.requests[-1]["input"] == server.requests[0]["input"]
    reader.click("stop")


def test_busy_after_cancellation_retries_with_bounds_and_recovers(configured, server):
    driver = configured
    gate = server.queue(delayed=True)
    reader = open_reader(driver, server, selected="first")
    reader.click("play")
    reader.wait.until(lambda _: len(server.requests) == 1)
    reader.click("stop")
    server.queue(status=429, retry_after="0.2")
    server.queue(status=429, retry_after="0.2")
    gate.set()
    started = time.monotonic()
    reader.click("play")
    reader.wait_state("playing")
    assert time.monotonic() - started >= 0.35
    assert len(server.requests) == 4
    reader.click("stop")
    for _ in range(3):
        server.queue(status=429, retry_after="0")
    reader.click("play")
    reader.wait_state("error")
    assert (
        "busy"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert len(server.requests) == 7
    reader.click("play")
    reader.wait_state("playing")
    reader.click("stop")


def test_bad_token_and_offline_endpoint_are_recoverable(configured, server):
    driver = configured
    reader = open_reader(driver, server, selected="first")
    reading_tab = driver.current_window_handle
    reader.click("settings")
    options_page(driver)
    save_field(driver, "token", "incorrect")
    driver.switch_to.window(reading_tab)
    reader.click("play")
    reader.wait_state("error")
    assert (
        "token"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    reader.click("settings")
    options_page(driver)
    save_field(driver, "token", TOKEN)
    save_field(driver, "base-url", "http://127.0.0.1:1")
    driver.switch_to.window(reading_tab)
    reader.click("play")
    reader.wait_state("error")
    assert (
        "Cannot reach"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    reader.click("settings")
    options_page(driver)
    save_field(driver, "base-url", f"http://127.0.0.1:{server.port}")
    driver.switch_to.window(reading_tab)
    reader.click("play")
    reader.wait_state("playing")
    reader.click("stop")


def test_navigation_discards_pending_audio(configured, server):
    driver = configured
    gate = server.queue(delayed=True)
    reader = open_reader(driver, server)
    reader.click("play")
    reader.wait.until(lambda _: len(server.requests) == 1)
    driver.get(f"http://reader.test:{server.port}/empty")
    gate.set()
    activate_reader(driver)
    empty = Reader(driver)
    empty.wait_state("error")
    empty.remains("error", 0.5)
    assert empty.highlight() == ""
    assert len(server.requests) == 1
