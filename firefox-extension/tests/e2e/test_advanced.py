"""Exercise advanced diagnostics in the installed extension."""

from harness import Reader, activate_reader, tone
from selenium.webdriver.common.by import By


def test_advanced_queue_gap_and_narrow_layout(configured, server, tmp_path):
    driver = configured
    driver.set_window_size(420, 850)
    server.queue(body=tone(1))
    gate = server.queue(body=tone(2), delayed=True)
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)
    root = reader.host.shadow_root
    panel = root.find_element(By.ID, "advanced-panel")
    assert not panel.is_displayed()
    reader.click("advanced-toggle")
    assert panel.is_displayed()
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: "waiting for server" in panel.text)
    reader.wait.until(lambda _: "Underruns: 1" in panel.text)
    assert "Last gap: sentence 2" in panel.text
    driver.save_screenshot(str(tmp_path / "advanced-narrow.png"))
    bounds = driver.execute_script(
        """const h=document.getElementById('kokoro-reader-controls');
        const r=h.getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
                width:innerWidth,height:innerHeight};"""
    )
    assert 0 <= bounds["left"] <= bounds["right"] <= bounds["width"]
    assert 0 <= bounds["top"] <= bounds["bottom"] <= bounds["height"]
    gate.set()
    reader.wait_state("playing")
    reader.click("stop")
    assert "Underruns: 0" in panel.text
    reader.click("advanced-toggle")
    assert not panel.is_displayed()


def test_advanced_shows_queued_audio_and_pause_reset(configured, server):
    driver = configured
    server.queue(body=tone(4))
    server.queue(body=tone(2))
    gate = server.queue(body=tone(2), delayed=True)
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("advanced-toggle")
    panel = reader.host.shadow_root.find_element(By.ID, "advanced-panel")
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: "Ready ahead: 1 sentences" in panel.text)
    assert "ready" in panel.text
    reader.click("play")
    reader.wait_state("paused")
    assert "paused" in panel.text
    assert "Ready ahead: 0 sentences" in panel.text
    gate.set()
    reader.click("stop")
    assert "Underruns: 0" in panel.text
