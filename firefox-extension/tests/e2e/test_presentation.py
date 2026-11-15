"""Check actual rendered bounds and keyboard controls in ordinary Firefox."""

import pytest
from harness import Reader, activate_reader
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys


@pytest.mark.parametrize(
    "width,zoom,dark",
    [(1100, 1, False), (420, 1, True), (900, 2, False), (640, 2, False)],
)
def test_control_bar_fits_viewport(configured, server, tmp_path, width, zoom, dark):
    driver = configured
    driver.set_window_size(width, 850)
    driver.get(f"http://reader.test:{server.port}/article")
    with driver.context(driver.CONTEXT_CHROME):
        driver.execute_script("gBrowser.selectedBrowser.fullZoom = arguments[0]", zoom)
    if dark:
        driver.execute_script(
            'document.body.style.cssText = "background:#152025;color:#edf8f5"'
        )
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    bounds = driver.execute_script(
        """const h=document.getElementById('kokoro-reader-controls');
        const r=h.getBoundingClientRect();
        const buttons=Array.from(h.shadowRoot.querySelectorAll('button'), b=>{
          const q=b.getBoundingClientRect();return {left:q.left,right:q.right,top:q.top,bottom:q.bottom};});
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,buttons};"""
    )
    assert bounds["left"] >= 0 and bounds["right"] <= bounds["width"]
    assert bounds["top"] >= 0 and bounds["bottom"] <= bounds["height"]
    for button in bounds["buttons"]:
        assert button["left"] >= bounds["left"] and button["right"] <= bounds["right"]
        assert button["top"] >= bounds["top"] and button["bottom"] <= bounds["bottom"]
    driver.save_screenshot(str(tmp_path / f"controls-{width}-{zoom}-{dark}.png"))
    reader.click("stop")


def test_keyboard_focus_toggle_escape_and_close(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)

    def focused():
        return driver.execute_script(
            "return document.getElementById('kokoro-reader-controls').shadowRoot.activeElement?.id"
        )

    assert focused() == "play"
    ActionChains(driver).send_keys(Keys.TAB, Keys.TAB).perform()
    assert focused() == "click-mode"
    ActionChains(driver).send_keys(Keys.SPACE).perform()
    assert (
        reader.host.shadow_root.find_element(By.ID, "click-mode").get_attribute(
            "aria-pressed"
        )
        == "true"
    )
    ActionChains(driver).send_keys(Keys.ESCAPE).perform()
    assert (
        reader.host.shadow_root.find_element(By.ID, "click-mode").get_attribute(
            "aria-pressed"
        )
        == "false"
    )
    ActionChains(driver).send_keys(Keys.TAB, Keys.TAB).perform()
    assert focused() == "close"
    ActionChains(driver).send_keys(Keys.ENTER).perform()
    assert driver.find_elements(By.ID, "kokoro-reader-controls") == []
