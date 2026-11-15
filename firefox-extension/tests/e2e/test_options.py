"""Exercise voice discovery and settings in the installed options page."""

from selenium.webdriver.common.by import By
from selenium.webdriver.support.select import Select
from selenium.webdriver.support.ui import WebDriverWait


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
