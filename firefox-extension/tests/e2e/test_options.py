"""Exercise voice discovery and settings in the installed options page."""

from selenium.webdriver.common.by import By
from selenium.webdriver.support.select import Select
from selenium.webdriver.support.ui import WebDriverWait


def test_narrow_settings_and_reader_stack_in_one_column(configured, tmp_path):
    driver = configured
    driver.set_window_size(390, 844)
    layout = driver.execute_script(
        """const settings=document.getElementById('settings-panel').getBoundingClientRect();
        const reader=document.getElementById('workspace').getBoundingClientRect();
        return {settingsBottom:settings.bottom, readerTop:reader.top,
          settingsWidth:settings.width, readerWidth:reader.width,
          viewportWidth:document.documentElement.clientWidth,
          scrollWidth:document.documentElement.scrollWidth};"""
    )
    assert layout["readerTop"] >= layout["settingsBottom"]
    assert layout["settingsWidth"] <= layout["viewportWidth"]
    assert layout["readerWidth"] <= layout["viewportWidth"]
    assert layout["scrollWidth"] <= layout["viewportWidth"]
    driver.save_screenshot(str(tmp_path / "narrow-settings.png"))


def test_voice_selection_restores_and_reports_rejected_token(configured, server):
    driver = configured
    wait = WebDriverWait(driver, 10)
    assert driver.find_element(By.ID, "status").text == "Connected. 2 voices available."
    Select(driver.find_element(By.ID, "voices")).select_by_value("af_bella")
    assert driver.find_element(By.ID, "voice").get_attribute("value") == "af_bella"
    driver.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    wait.until(lambda d: d.find_element(By.ID, "status").text == "Settings saved.")
    driver.refresh()
    wait.until(lambda d: len(Select(d.find_element(By.ID, "voices")).options) == 3)
    assert driver.find_element(By.ID, "voice").get_attribute("value") == "af_bella"
    assert (
        Select(
            driver.find_element(By.ID, "voices")
        ).first_selected_option.get_attribute("value")
        == "af_bella"
    )
    voice = driver.find_element(By.ID, "voice")
    voice.clear()
    voice.send_keys("af_manual")
    assert (
        Select(
            driver.find_element(By.ID, "voices")
        ).first_selected_option.get_attribute("value")
        == ""
    )
    Select(driver.find_element(By.ID, "voices")).select_by_value("af_bella")
    assert voice.get_attribute("value") == "af_bella"
    token = driver.find_element(By.ID, "token")
    token.clear()
    token.send_keys("incorrect")
    assert not driver.find_element(By.ID, "voices").is_enabled()
    driver.find_element(By.ID, "test").click()
    wait.until(
        lambda d: d.find_element(By.ID, "status").text == "Incorrect server token."
    )
    assert not driver.find_element(By.ID, "voices").is_enabled()
    assert driver.find_element(By.ID, "voice").get_attribute("value") == "af_bella"
    assert server.history[-1]["path"] == "/v1/voices"
    assert server.history[-1]["status"] == 401


def test_workspace_edits_seeks_and_uses_unsaved_settings(configured, server):
    driver = configured
    wait = WebDriverWait(driver, 10)
    assert driver.find_element(By.ID, "passage-text").text.startswith(
        "The Rainbow Passage"
    )
    driver.find_element(By.ID, "edit-text").click()
    sample = driver.find_element(By.ID, "sample-text")
    sample.clear()
    sample.send_keys("First sentence. Second sentence. Third sentence.")
    driver.find_element(By.ID, "edit-text").click()
    voice = driver.find_element(By.ID, "voice")
    voice.clear()
    voice.send_keys("af_bella")
    speed = driver.find_element(By.ID, "speed")
    speed.clear()
    speed.send_keys("1.5")
    gate = server.queue(delayed=True)
    driver.find_element(By.CSS_SELECTOR, '[data-sentence-index="1"]').click()
    wait.until(lambda _: len(server.requests) >= 1)
    assert server.requests[0]["input"] == "Second sentence."
    assert server.requests[0]["voice"] == "af_bella"
    assert server.requests[0]["speed"] == 1.5
    driver.find_element(By.ID, "play-sample").click()
    assert driver.find_element(By.ID, "sample-status").text == "Paused"
    driver.find_element(By.ID, "stop-sample").click()
    assert driver.find_element(By.ID, "sample-status").text == "Ready"
    gate.set()


def test_workspace_reports_rejected_token(configured):
    driver = configured
    token = driver.find_element(By.ID, "token")
    token.clear()
    token.send_keys("incorrect")
    driver.find_element(By.ID, "play-sample").click()
    WebDriverWait(driver, 10).until(
        lambda d: "token is incorrect" in d.find_element(By.ID, "sample-status").text
    )
    assert driver.find_element(By.ID, "play-sample").is_enabled()
