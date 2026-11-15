"""Exercise connection testing in the installed options page."""

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def test_connection_populates_voices_and_reports_rejected_token(configured, server):
    driver = configured
    assert driver.find_element(By.ID, "status").text == "Connected. 1 voices available."
    assert [
        option.get_attribute("value")
        for option in driver.find_elements(By.CSS_SELECTOR, "#voices option")
    ] == ["af_heart"]
    token = driver.find_element(By.ID, "token")
    token.clear()
    token.send_keys("incorrect")
    driver.find_element(By.ID, "test").click()
    WebDriverWait(driver, 10).until(
        lambda browser: browser.find_element(By.ID, "status").text
        == "Incorrect server token."
    )
    assert server.history[-1]["path"] == "/v1/voices"
    assert server.history[-1]["status"] == 401
